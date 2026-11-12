import { lateCharges } from "@autoflow/shared";
import { z } from "zod";
import { audit } from "../audit";
import { decryptSecret, encryptSecret } from "../crypto";
import type { Q } from "../db";
import { HttpError, conflict, notFound, parseJson } from "../http";
import { verifyMetaSignature } from "../providers";
import type { Router } from "../router";
import type { Deps, TenantPrincipal } from "../types";
import { ingestEvents, type IncomingEvent } from "../webhooks";
import { tctx } from "./tenant";

const uuid = z.string().uuid();
const N = (v: unknown) => Number(v ?? 0);
const hint = (secret: string) => `…${secret.slice(-4)}`;
const KINDS = z.enum(["whatsapp", "payments"]);
const WaConfig = z.object({ phoneNumberId: z.string().regex(/^\d{5,25}$/), wabaId: z.string().regex(/^\d{5,25}$/).optional(), accessToken: z.string().min(8).max(1000) });
const PayConfig = z.object({ provider: z.enum(["sandbox"]).default("sandbox"), apiKey: z.string().min(8).max(500) }); // gateway real: ADR-0005 (aguardando aprovação)

export function registerIntegrationRoutes(r: Router, deps: Deps): void {
  const INT = { auth: "tenant", permission: "integrations:manage" } as const;
  const tx = <T>(p: TenantPrincipal, fn: (q: Q) => Promise<T>) => deps.db.tx(tctx(p), fn);
  const secretOf = async (q: Q, kind: "whatsapp" | "payments") => {
    const c = await q.one<{ secret_enc: string; config: Record<string, string>; provider: string }>("select secret_enc, config, provider from integration_connections where kind = $1 and status = 'connected'", [kind]);
    return c ? { token: await decryptSecret(c.secret_enc, deps.config.encryptionKey), config: c.config, provider: c.provider } : null;
  };

  // ===== Conexões por tenant: segredo cifrado (AES-GCM), rotação e desconexão que apaga o segredo =====
  r.get("/integrations", INT, async (c) => c.json({ connections: await tx(c.get("tenant"), (q) => q.many("select kind, provider, status, secret_hint, secret_version, config, connected_at, disconnected_at from integration_connections order by connected_at desc limit 50")) }));
  r.post("/integrations/:kind/connect", INT, async (c) => {
    const p = c.get("tenant"); const kind = KINDS.parse(c.req.param("kind"));
    const b = kind === "whatsapp" ? await parseJson(c, WaConfig) : await parseJson(c, PayConfig);
    const secret = "accessToken" in b ? b.accessToken : b.apiKey;
    const enc = await encryptSecret(secret, deps.config.encryptionKey);
    const cfg = "phoneNumberId" in b ? { phone_number_id: b.phoneNumberId, ...(b.wabaId ? { waba_id: b.wabaId } : {}) } : {};
    try {
      return c.json(await tx(p, async (q) => {
        const row = await q.one<{ id: string }>("insert into integration_connections (tenant_id, kind, provider, secret_enc, secret_hint, config) values ($1,$2,$3,$4,$5,$6) returning id", [p.tenantId, kind, kind === "whatsapp" ? deps.whatsapp.name : (b as { provider: string }).provider, enc, hint(secret), JSON.stringify(cfg)]);
        await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: `integration.${kind}.connect`, entityType: "integration", entityId: row!.id, requestId: c.get("requestId") });
        return { id: row!.id, hint: hint(secret) };
      }), 201);
    } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("already_connected"); throw e; }
  });
  r.post("/integrations/:kind/rotate", INT, async (c) => {
    const p = c.get("tenant"); const kind = KINDS.parse(c.req.param("kind")); const b = await parseJson(c, z.object({ secret: z.string().min(8).max(1000) }));
    const enc = await encryptSecret(b.secret, deps.config.encryptionKey);
    return c.json(await tx(p, async (q) => {
      const x = await q.one<{ secret_version: number }>("update integration_connections set secret_enc = $2, secret_hint = $3, secret_version = secret_version + 1, updated_at = now() where kind = $1 and status = 'connected' returning secret_version", [kind, enc, hint(b.secret)]);
      if (!x) throw notFound("not_connected");
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: `integration.${kind}.rotate`, entityType: "integration", entityId: kind, requestId: c.get("requestId") });
      return { version: x.secret_version, hint: hint(b.secret) };
    }));
  });
  r.delete("/integrations/:kind", INT, async (c) => {
    const p = c.get("tenant"); const kind = KINDS.parse(c.req.param("kind"));
    await tx(p, async (q) => {
      const x = await q.query("update integration_connections set status = 'disconnected', secret_enc = null, secret_hint = null, disconnected_at = now(), updated_at = now() where kind = $1 and status = 'connected'", [kind]);
      if (x.rowCount !== 1) throw notFound("not_connected");
      await q.query("update outbox set status = 'skipped', last_error = 'disconnected' where status = 'pending' and kind = 'whatsapp'");
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: `integration.${kind}.disconnect`, entityType: "integration", entityId: kind, requestId: c.get("requestId") });
    });
    return c.json({ ok: true });
  });

  // ===== WhatsApp: envio de template (sempre via outbox; marketing exige consentimento) =====
  r.post("/whatsapp/send", { auth: "tenant", permission: "crm:manage" }, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ customerId: uuid, template: z.string().regex(/^[a-z0-9_]{1,512}$/), category: z.enum(["utility", "marketing", "authentication"]), params: z.array(z.string().max(200)).max(10).default([]), lang: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/).default("pt_BR") }));
    return c.json(await tx(p, async (q) => {
      if (!(await q.one("select 1 from integration_connections where kind = 'whatsapp' and status = 'connected'"))) throw conflict("whatsapp_not_connected");
      const cu = await q.one<{ phone_e164: string; marketing_opt_in: boolean }>("select phone_e164, marketing_opt_in from customers where id = $1", [b.customerId]); if (!cu) throw notFound("customer_not_found");
      if (b.category === "marketing" && !cu.marketing_opt_in) throw conflict("no_marketing_consent");
      const unit = (await q.one<{ id: string }>("select id from units order by is_default desc, created_at limit 1"))!.id;
      const m = await q.one<{ id: string }>("insert into wa_messages (tenant_id, customer_id, direction, category, template, to_phone) values ($1,$2,'out',$3,$4,$5) returning id", [p.tenantId, b.customerId, b.category, b.template, cu.phone_e164]);
      await q.query("insert into outbox (tenant_id, unit_id, kind, payload) values ($1,$2,'whatsapp',$3)", [p.tenantId, unit, JSON.stringify({ waMessageId: m!.id, params: b.params, lang: b.lang })]);
      return { id: m!.id, status: "queued" };
    }), 202);
  });
  r.get("/whatsapp/messages", { auth: "tenant", permission: "crm:read" }, async (c) => c.json({ messages: await tx(c.get("tenant"), (q) => q.many("select id, direction, category, template, status, error, created_at from wa_messages order by created_at desc limit 100")) }));

  // ===== Web Push =====
  r.post("/push/subscribe", { auth: "tenant", permission: "any-member" }, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, z.object({ endpoint: z.string().url().startsWith("https://").max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }));
    await tx(p, (q) => q.query("insert into push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth) values ($1,$2,$3,$4,$5) on conflict (tenant_id, endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth", [p.tenantId, p.userId, b.endpoint, b.keys.p256dh, b.keys.auth]));
    return c.json({ ok: true }, 201);
  });
  r.delete("/push/subscribe", { auth: "tenant", permission: "any-member" }, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, z.object({ endpoint: z.string().max(1000) }));
    await tx(p, (q) => q.query("delete from push_subscriptions where endpoint = $1 and user_id = $2", [b.endpoint, p.userId])); return c.json({ ok: true });
  });
  r.post("/push/test", { auth: "tenant", permission: "any-member" }, async (c) => {
    const p = c.get("tenant"); const subs = await tx(p, (q) => q.many<{ endpoint: string; p256dh: string; auth: string }>("select endpoint, p256dh, auth from push_subscriptions where user_id = $1", [p.userId]));
    for (const s of subs) await deps.push.send(s, { title: "AutoFlow", body: "Notificação de teste" });
    return c.json({ sent: subs.length });
  });

  // ===== Cobrança online de parcela (Pix/boleto/cartão hospedado: dados de cartão nunca tocam o AutoFlow) =====
  r.post("/finance/installments/:id/charge", { auth: "tenant", permission: "finance:receive" }, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id")); const b = await parseJson(c, z.object({ method: z.enum(["pix", "boleto", "card"]), walletId: uuid }));
    const prep = await tx(p, async (q) => {
      const conn = await secretOf(q, "payments"); if (!conn) throw conflict("payments_not_connected");
      const i = await q.one<any>(`select i.id, i.due_date::text due, i.amount_cents, d.unit_id, d.kind, d.description, d.cancelled_at is not null cancelled,
          coalesce((select sum(a.principal_cents) from fin_allocations a join fin_settlements s on s.tenant_id = a.tenant_id and s.id = a.settlement_id where a.installment_id = i.id and s.reversed_at is null),0)::bigint paid
        from fin_installments i join fin_documents d on d.tenant_id = i.tenant_id and d.id = i.doc_id where i.id = $1`, [id]);
      if (!i) throw notFound("installment_not_found");
      if (i.kind !== "receivable" || i.cancelled) throw conflict("not_chargeable");
      if (!(await q.one("select 1 from fin_wallets where id = $1 and active", [b.walletId]))) throw notFound("wallet_not_found");
      const principal = N(i.amount_cents) - N(i.paid); if (principal <= 0) throw conflict("already_paid");
      await q.query("insert into fin_settings (tenant_id) values ($1) on conflict do nothing", [p.tenantId]);
      const st = (await q.one<any>("select late_fine_bp, late_interest_bp_month from fin_settings"))!;
      const today = (await q.one<{ d: string }>("select (now() at time zone 'America/Sao_Paulo')::date::text d"))!.d;
      const lc = lateCharges({ principalCents: principal, dueDate: i.due, on: today, fineBp: st.late_fine_bp, interestBpMonth: st.late_interest_bp_month });
      return { conn, unitId: i.unit_id as string, principal, amount: principal + lc.fineCents + lc.interestCents, today, description: String(i.description ?? "Parcela") };
    });
    const rowId = crypto.randomUUID();
    const ch = await deps.payments.createCharge(prep.conn.token, { amountCents: prep.amount, method: b.method, description: prep.description.slice(0, 100), externalReference: `chg.${p.tenantId}.${rowId}` });
    try {
      await tx(p, (q) => q.query("insert into payment_charges (id, tenant_id, unit_id, installment_id, wallet_id, provider, provider_charge_id, method, amount_cents, principal_cents, quoted_on, checkout_url, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [rowId, p.tenantId, prep.unitId, id, b.walletId, deps.payments.name, ch.providerChargeId, b.method, prep.amount, prep.principal, prep.today, ch.checkoutUrl, p.userId]));
    } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("charge_pending"); throw e; }
    return c.json({ id: rowId, amountCents: prep.amount, checkoutUrl: ch.checkoutUrl }, 201);
  });
  r.get("/finance/charges", { auth: "tenant", permission: "finance:read" }, async (c) => c.json({ charges: await tx(c.get("tenant"), (q) => q.many("select id, installment_id, method, amount_cents, status, checkout_url, paid_at, created_at from payment_charges order by created_at desc limit 100")) }));

  // ===== Receptores de webhook (públicos; autenticidade = assinatura do corpo bruto) =====
  const pub = { auth: "public" } as const;
  r.get("/webhooks/whatsapp", pub, async (c) => {
    const ok = deps.config.waVerifyToken && c.req.query("hub.mode") === "subscribe" && c.req.query("hub.verify_token") === deps.config.waVerifyToken;
    if (!ok) throw new HttpError(403, "verification_failed");
    return c.text(c.req.query("hub.challenge") ?? "");
  });
  r.post("/webhooks/whatsapp", pub, async (c) => {
    const raw = await c.req.text();
    if (!(await verifyMetaSignature(deps.config.metaAppSecret, raw, c.req.header("x-hub-signature-256") ?? null))) throw new HttpError(401, "invalid_signature");
    let body: any; try { body = JSON.parse(raw); } catch { throw new HttpError(400, "invalid_json"); }
    const events: IncomingEvent[] = [];
    for (const en of body?.entry ?? []) for (const ch of en?.changes ?? []) {
      const v = ch?.value ?? {}; const phoneNumberId = String(v?.metadata?.phone_number_id ?? "");
      for (const s of v.statuses ?? []) events.push({ eventId: `${s.id}:${s.status}`, type: "status", payload: { phoneNumberId, id: s.id, status: s.status, error: s.errors?.[0]?.code } });
      for (const m of v.messages ?? []) events.push({ eventId: String(m.id), type: "inbound", payload: { phoneNumberId, id: m.id, from: m.from, text: m.type === "text" ? m.text?.body : null } });
    }
    return c.json(await ingestEvents(deps, "whatsapp", events));
  });
  r.post("/webhooks/payments/:provider", pub, async (c) => {
    const raw = await c.req.text();
    if (c.req.param("provider") !== deps.payments.name || !(await deps.payments.verifyWebhook(raw, (n) => c.req.header(n)))) throw new HttpError(401, "invalid_signature");
    let b: any; try { b = JSON.parse(raw); } catch { throw new HttpError(400, "invalid_json"); }
    if (typeof b?.event_id !== "string" || typeof b?.type !== "string") throw new HttpError(422, "invalid_event");
    return c.json(await ingestEvents(deps, "sandbox_payments", [{ eventId: b.event_id, type: b.type, payload: b }]));
  });
}
