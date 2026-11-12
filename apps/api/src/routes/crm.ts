import { DEFAULT_REMINDER_DAYS, REMINDER_KINDS, addDays, checkLimit, couponDiscount, loyaltyPoints, normalizePlate } from "@autoflow/shared";
import { z } from "zod";
import { audit } from "../audit";
import type { Q } from "../db";
import { HttpError, conflict, notFound, parseJson } from "../http";
import { optOutPath, verifyOptOut } from "../optout";
import type { Router } from "../router";
import type { Deps, TenantPrincipal } from "../types";
import { loadModel, present } from "./estimates";
import { tctx } from "./tenant";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const N = (v: unknown) => Number(v ?? 0);
const TODAY = "(now() at time zone 'America/Sao_Paulo')::date";
const optOutHtml = (msg: string, form?: string) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Preferências de contato</title></head><body style="font:16px system-ui;max-width:32rem;margin:2rem auto;padding:0 1rem"><h1>Preferências de contato</h1><p>${msg}</p>${form ?? ""}</body></html>`;

/** Registra consentimento de marketing (log por trigger). Opt-out cancela pendências imediatamente. */
export const setConsent = async (q: Q, tenantId: string, customerId: string, optIn: boolean, source: string) => {
  await q.query("select set_config('app.consent_source', $1, true)", [source]);
  const x = await q.query("update customers set marketing_opt_in = $2 where id = $1", [customerId, optIn]);
  if (x.rowCount !== 1) throw notFound("customer_not_found");
  if (!optIn) {
    // Imediato: nada pendente é enviado depois do opt-out.
    await q.query("update outbox set status = 'skipped', last_error = 'opted_out' where status = 'pending' and kind = 'campaign' and payload->>'customerId' = $1", [customerId]);
    await q.query("update service_reminders set status = 'cancelled' where customer_id = $1 and status in ('pending','queued')", [customerId]);
  }
};

export function registerCrmRoutes(r: Router, deps: Deps): void {
  const READ = { auth: "tenant", permission: "crm:read" } as const;
  const MANAGE = { auth: "tenant", permission: "crm:manage" } as const;
  const CAMP = { auth: "tenant", permission: "campaigns:manage" } as const;
  const tx = <T>(p: TenantPrincipal, fn: (q: Q) => Promise<T>) => deps.db.tx(tctx(p), fn);

  // ===== Conversão de lead: cliente → (agendamento) → OS =====
  r.post("/leads/:id/convert", MANAGE, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ createOrder: z.boolean().default(false), scheduledFor: z.string().datetime().optional(), vehicle: z.object({ plate: z.string(), make: z.string().trim().max(60).optional(), model: z.string().trim().max(60).optional(), year: z.number().int().min(1900).max(2100).optional() }).optional(), referrerCustomerId: uuid.optional(), marketingOptIn: z.boolean().default(false) }));
    if (b.scheduledFor && b.createOrder) throw new HttpError(422, "schedule_or_order");
    if (b.scheduledFor && new Date(b.scheduledFor).getTime() < Date.now() - 60_000) throw new HttpError(422, "schedule_in_past");
    if (b.createOrder) {
      const monthly = await deps.db.tx({ actor: "tenant", tenantId: p.tenantId, userId: p.userId, unitScope: "all" }, (q) => q.one<{ n: string }>("select count(*) as n from service_orders where created_at >= date_trunc('month', now())"));
      const lim = checkLimit(p.entitlements, "orders.monthly", Number(monthly?.n ?? 0)); if (!lim.ok) throw new HttpError(403, "limit_reached", `orders.monthly=${lim.limit}`);
    }
    const out = await tx(p, async (q) => {
      const l = await q.one<any>("select * from leads where id = $1 for update", [id]); if (!l) throw notFound("lead_not_found");
      if (l.converted_order_id) throw conflict("lead_already_converted");
      let customerId: string = l.converted_customer_id;
      if (!customerId) {
        const ex = await q.one<{ id: string }>("select id from customers where phone_e164 = $1 order by created_at limit 1", [l.phone_e164]);
        if (ex) customerId = ex.id;
        else {
          await q.query("select set_config('app.consent_source', 'lead_conversion', true)");
          customerId = (await q.one<{ id: string }>("insert into customers (tenant_id, name, phone_e164, email, origin, marketing_opt_in) values ($1,$2,$3,$4,$5,$6) returning id", [p.tenantId, l.name, l.phone_e164, l.email, `lead:${l.source}${l.campaign ? `:${l.campaign}` : ""}`, b.marketingOptIn]))!.id;
        }
      }
      let vehicleId: string | null = null;
      const plate = normalizePlate(b.vehicle?.plate ?? l.plate ?? "");
      if (b.vehicle && !plate) throw new HttpError(422, "invalid_plate");
      if (plate) {
        const v = await q.one<{ id: string; customer_id: string }>("select id, customer_id from vehicles where plate = $1", [plate]);
        if (v) { if (v.customer_id !== customerId) throw conflict("plate_belongs_to_other_customer"); vehicleId = v.id; }
        else vehicleId = (await q.one<{ id: string }>("insert into vehicles (tenant_id, customer_id, plate, make, model, year) values ($1,$2,$3,$4,$5,$6) returning id", [p.tenantId, customerId, plate, b.vehicle?.make ?? null, b.vehicle?.model ?? null, b.vehicle?.year ?? null]))!.id;
      }
      let order: { id: string; number: number } | null = null;
      if (b.createOrder) {
        if (!vehicleId) throw new HttpError(422, "vehicle_required");
        const n = await q.one<{ last_number: number }>("insert into os_counters (tenant_id, unit_id, last_number) values ($1,$2,1) on conflict (tenant_id, unit_id) do update set last_number = os_counters.last_number + 1 returning last_number", [p.tenantId, l.unit_id]);
        const o = await q.one<{ id: string }>("insert into service_orders (tenant_id, unit_id, number, customer_id, vehicle_id, notes, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id", [p.tenantId, l.unit_id, n!.last_number, customerId, vehicleId, `Origem: lead ${l.service ?? ""}`.trim().slice(0, 200), p.userId]);
        order = { id: o!.id, number: n!.last_number };
        await q.query("insert into os_timeline (tenant_id, unit_id, os_id, kind, title) values ($1,$2,$3,'order.created',$4)", [p.tenantId, l.unit_id, order.id, `OS ${order.number} aberta`]).catch(() => undefined);
      }
      const to = b.scheduledFor ? "scheduled" : order ? "won" : l.status;
      await q.query("update leads set converted_customer_id = $2, converted_order_id = $3, converted_at = now(), scheduled_for = $4, status = $5, updated_at = now() where id = $1", [id, customerId, order?.id ?? null, b.scheduledFor ?? null, to]);
      await q.query("insert into lead_events (tenant_id, unit_id, lead_id, kind, from_status, to_status, note, user_id) values ($1,$2,$3,'converted',$4,$5,$6,$7)", [p.tenantId, l.unit_id, id, l.status, to, order ? `OS ${order.number}` : b.scheduledFor ? `agendado ${b.scheduledFor}` : "cliente vinculado", p.userId]);
      if (b.referrerCustomerId) {
        if (b.referrerCustomerId === customerId) throw new HttpError(422, "self_referral");
        if (!(await q.one("select 1 from customers where id = $1", [b.referrerCustomerId]))) throw notFound("referrer_not_found");
        await q.query("insert into referrals (tenant_id, referrer_customer_id, referred_customer_id) values ($1,$2,$3) on conflict do nothing", [p.tenantId, b.referrerCustomerId, customerId]);
      }
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "lead.convert", entityType: "lead", entityId: id, requestId: c.get("requestId") });
      return { customerId, vehicleId, orderId: order?.id ?? null, orderNumber: order?.number ?? null, status: to };
    });
    return c.json(out, 201);
  });

  // ===== Consentimento / opt-out (auditável) =====
  r.post("/crm/customers/:id/consent", MANAGE, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id")); const b = await parseJson(c, z.object({ optIn: z.boolean(), source: z.enum(["staff", "phone", "whatsapp", "in_person"]).default("staff") }));
    await tx(p, (q) => setConsent(q, p.tenantId, id, b.optIn, b.source));
    return c.json({ ok: true });
  });
  r.get("/crm/customers/:id/consent-log", READ, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    return c.json({ log: await tx(p, (q) => q.many("select action, source, actor_id, at from marketing_consent_log where customer_id = $1 order by id", [id])) });
  });
  const pub = { auth: "public" } as const;
  r.get("/optout/:tenantId/:customerId", pub, async (c) => {
    const tenantId = c.req.param("tenantId") ?? ""; const customerId = c.req.param("customerId") ?? ""; const sig = c.req.query("sig") ?? "";
    if (!uuid.safeParse(tenantId).success || !uuid.safeParse(customerId).success || !(await verifyOptOut(deps.config.encryptionKey, tenantId, customerId, sig))) return c.html(optOutHtml("Link inválido."), 404);
    return c.html(optOutHtml("Deseja deixar de receber mensagens de marketing desta oficina?", `<form method="post" action=""><input type="hidden" name="sig" value="${sig.replace(/[^0-9a-f]/g, "")}"><button style="padding:.75rem 1.25rem;font:inherit">Sim, parar de receber</button></form>`));
  });
  r.post("/optout/:tenantId/:customerId", pub, async (c) => {
    const tenantId = c.req.param("tenantId") ?? ""; const customerId = c.req.param("customerId") ?? "";
    const sig = c.req.query("sig") ?? String((await c.req.parseBody().catch(() => ({})) as Record<string, unknown>).sig ?? "");
    if (!uuid.safeParse(tenantId).success || !uuid.safeParse(customerId).success || !(await verifyOptOut(deps.config.encryptionKey, tenantId, customerId, sig))) return c.html(optOutHtml("Link inválido."), 404);
    await deps.db.tx({ actor: "tenant", tenantId, unitScope: "all" }, (q) => setConsent(q, tenantId, customerId, false, "self_service_link")).catch((e) => { if (e instanceof HttpError && e.status === 404) return; throw e; });
    return c.html(optOutHtml("Pronto. Você não receberá mais mensagens de marketing."));
  });

  // ===== Cupons =====
  const Coupon = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,20}$/), kind: z.enum(["percent", "fixed"]), value: z.number().int().min(1).max(10_000_000), minTotalCents: z.number().int().min(0).default(0), validFrom: date.optional(), validUntil: date.optional(), maxUses: z.number().int().min(1).optional(), customerId: uuid.optional() });
  r.post("/crm/coupons", MANAGE, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, Coupon);
    if (b.kind === "percent" && b.value > 100) throw new HttpError(422, "invalid_percent");
    try { return c.json(await tx(p, (q) => q.one("insert into coupons (tenant_id, code, kind, value, min_total_cents, valid_from, valid_until, max_uses, customer_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, code", [p.tenantId, b.code, b.kind, b.value, b.minTotalCents, b.validFrom ?? null, b.validUntil ?? null, b.maxUses ?? null, b.customerId ?? null])), 201); }
    catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("coupon_exists"); throw e; }
  });
  r.get("/crm/coupons", READ, async (c) => c.json({ coupons: await tx(c.get("tenant"), (q) => q.many("select c.id, c.code, c.kind, c.value, c.min_total_cents, c.valid_from, c.valid_until, c.max_uses, c.active, (select count(*)::int from coupon_redemptions r where r.coupon_id = c.id) used from coupons c order by c.created_at desc limit 200")) }));
  r.post("/crm/coupons/redeem", MANAGE, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, z.object({ code: z.string().trim().toUpperCase(), osId: uuid }));
    return c.json(await tx(p, async (q) => {
      const cp = await q.one<any>("select *, valid_from::text vf, valid_until::text vu from coupons where code = $1 for update", [b.code]); if (!cp || !cp.active) throw notFound("coupon_not_found");
      const o = await q.one<{ customer_id: string; status: string }>("select customer_id, status from service_orders where id = $1", [b.osId]); if (!o) throw notFound("order_not_found");
      if (o.status === "cancelled") throw conflict("order_cancelled");
      const today = (await q.one<{ d: string }>(`select ${TODAY}::text d`))!.d;
      if ((cp.vf && today < cp.vf) || (cp.vu && today > cp.vu)) throw new HttpError(422, "coupon_out_of_validity");
      if (cp.customer_id && cp.customer_id !== o.customer_id) throw new HttpError(422, "coupon_not_for_customer");
      if (cp.max_uses !== null && N((await q.one<{ n: string }>("select count(*) n from coupon_redemptions where coupon_id = $1", [cp.id]))!.n) >= cp.max_uses) throw conflict("coupon_exhausted");
      const cur = (await loadModel(q, b.osId)).versions.find((v) => v.status === "published");
      const total = (cur?.items ?? []).map(present).filter((i) => i.status.startsWith("approved")).reduce((s, i) => s + i.totalCents, 0);
      if (total < N(cp.min_total_cents)) throw new HttpError(422, "coupon_min_total");
      const discount = couponDiscount(cp.kind, cp.value, total);
      try { await q.query("insert into coupon_redemptions (tenant_id, coupon_id, os_id, customer_id, discount_cents) values ($1,$2,$3,$4,$5)", [p.tenantId, cp.id, b.osId, o.customer_id, discount]); }
      catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("coupon_already_used_on_order"); throw e; }
      return { discountCents: discount, totalCents: total };
    }), 201);
  });

  // ===== Fidelidade e indicações =====
  r.get("/crm/loyalty/settings", READ, async (c) => c.json(await tx(c.get("tenant"), async (q) => (await q.one("select points_per_real, referral_bonus_points from loyalty_settings")) ?? { points_per_real: 1, referral_bonus_points: 100 })));
  r.put("/crm/loyalty/settings", MANAGE, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, z.object({ pointsPerReal: z.number().int().min(0).max(100), referralBonusPoints: z.number().int().min(0).max(100000) }));
    await tx(p, (q) => q.query("insert into loyalty_settings (tenant_id, points_per_real, referral_bonus_points) values ($1,$2,$3) on conflict (tenant_id) do update set points_per_real = excluded.points_per_real, referral_bonus_points = excluded.referral_bonus_points", [p.tenantId, b.pointsPerReal, b.referralBonusPoints]));
    return c.json({ ok: true });
  });
  const balance = async (q: Q, customerId: string) => N((await q.one<{ s: string }>("select coalesce(sum(points),0)::bigint s from loyalty_ledger where customer_id = $1", [customerId]))!.s);
  r.post("/crm/orders/:id/award-points", MANAGE, async (c) => {
    const p = c.get("tenant"); const osId = uuid.parse(c.req.param("id"));
    return c.json(await tx(p, async (q) => {
      const o = await q.one<{ customer_id: string; status: string }>("select customer_id, status from service_orders where id = $1", [osId]); if (!o) throw notFound("order_not_found");
      const inv = await q.one<{ net_cents: string }>("select net_cents from fin_documents where os_id = $1 and kind = 'receivable' and cancelled_at is null", [osId]);
      if (!inv) throw conflict("order_not_invoiced");
      await q.query("insert into loyalty_settings (tenant_id) values ($1) on conflict do nothing", [p.tenantId]);
      const st = (await q.one<{ points_per_real: number; referral_bonus_points: number }>("select points_per_real, referral_bonus_points from loyalty_settings"))!;
      const pts = loyaltyPoints(N(inv.net_cents), st.points_per_real);
      if (pts === 0) return { points: 0, awarded: false };
      try { await q.query("insert into loyalty_ledger (tenant_id, customer_id, points, reason, os_id, created_by) values ($1,$2,$3,'earn',$4,$5)", [p.tenantId, o.customer_id, pts, osId, p.userId]); }
      catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("points_already_awarded"); throw e; }
      // Indicação: premia o indicador na primeira OS faturada do indicado.
      const ref = await q.one<{ id: string; referrer_customer_id: string }>("select id, referrer_customer_id from referrals where referred_customer_id = $1 and status = 'pending' for update", [o.customer_id]);
      let referralPoints = 0;
      if (ref && st.referral_bonus_points > 0) {
        await q.query("insert into loyalty_ledger (tenant_id, customer_id, points, reason, os_id, note, created_by) values ($1,$2,$3,'referral',$4,'indicação',$5)", [p.tenantId, ref.referrer_customer_id, st.referral_bonus_points, osId, p.userId]);
        await q.query("update referrals set status = 'rewarded', rewarded_at = now() where id = $1", [ref.id]); referralPoints = st.referral_bonus_points;
      }
      return { points: pts, awarded: true, referralPoints, balance: await balance(q, o.customer_id) };
    }), 201);
  });
  r.post("/crm/customers/:id/points/redeem", MANAGE, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id")); const b = await parseJson(c, z.object({ points: z.number().int().min(1).max(1_000_000), note: z.string().trim().min(3).max(200) }));
    return c.json(await tx(p, async (q) => {
      if (!(await q.one("select 1 from customers where id = $1 for update", [id]))) throw notFound("customer_not_found"); // serializa resgates do cliente
      if ((await balance(q, id)) < b.points) throw conflict("insufficient_points");
      await q.query("insert into loyalty_ledger (tenant_id, customer_id, points, reason, note, created_by) values ($1,$2,$3,'redeem',$4,$5)", [p.tenantId, id, -b.points, b.note, p.userId]);
      return { balance: await balance(q, id) };
    }));
  });
  r.get("/crm/customers/:id/loyalty", READ, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    return c.json(await tx(p, async (q) => ({ balance: await balance(q, id), history: await q.many("select points, reason, os_id, note, created_at from loyalty_ledger where customer_id = $1 order by id desc limit 100", [id]) })));
  });
  r.post("/crm/referrals", MANAGE, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, z.object({ referrerCustomerId: uuid, referredCustomerId: uuid }));
    if (b.referrerCustomerId === b.referredCustomerId) throw new HttpError(422, "self_referral");
    try { return c.json(await tx(p, (q) => q.one("insert into referrals (tenant_id, referrer_customer_id, referred_customer_id) values ($1,$2,$3) returning id", [p.tenantId, b.referrerCustomerId, b.referredCustomerId])), 201); }
    catch (e) { const code = (e as { code?: string }).code; if (code === "23505") throw conflict("already_referred"); if (code === "23503") throw notFound("customer_not_found"); throw e; }
  });
  r.get("/crm/referrals", READ, async (c) => c.json({ referrals: await tx(c.get("tenant"), (q) => q.many("select id, referrer_customer_id, referred_customer_id, status, rewarded_at from referrals order by created_at desc limit 200")) }));

  // ===== Lembretes de revisão/óleo/alinhamento =====
  r.post("/crm/orders/:id/reminders", MANAGE, async (c) => {
    const p = c.get("tenant"); const osId = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ items: z.array(z.object({ kind: z.enum(REMINDER_KINDS), inDays: z.number().int().min(1).max(1825).optional() })).min(1).max(4) }));
    return c.json(await tx(p, async (q) => {
      const o = await q.one<{ customer_id: string; vehicle_id: string }>("select customer_id, vehicle_id from service_orders where id = $1", [osId]); if (!o) throw notFound("order_not_found");
      const today = (await q.one<{ d: string }>(`select ${TODAY}::text d`))!.d; const created: string[] = [];
      for (const it of b.items) {
        const due = addDays(today, it.inDays ?? DEFAULT_REMINDER_DAYS[it.kind]);
        const x = await q.one<{ id: string }>("insert into service_reminders (tenant_id, customer_id, vehicle_id, kind, due_date, source_os_id) values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning id", [p.tenantId, o.customer_id, o.vehicle_id, it.kind, due, osId]);
        if (x) created.push(x.id);
      }
      return { created: created.length };
    }), 201);
  });
  r.get("/crm/reminders", READ, async (c) => {
    const p = c.get("tenant"); const until = c.req.query("until") ? date.parse(c.req.query("until")) : null; const status = z.enum(["pending", "queued", "done", "cancelled"]).default("pending").parse(c.req.query("status") ?? undefined);
    return c.json({ reminders: await tx(p, (q) => q.many("select r.id, r.kind, r.due_date, r.status, c.name customer_name, v.plate from service_reminders r join customers c on c.tenant_id = r.tenant_id and c.id = r.customer_id join vehicles v on v.tenant_id = r.tenant_id and v.id = r.vehicle_id where r.status = $1 and ($2::date is null or r.due_date <= $2) order by r.due_date limit 200", [status, until])) });
  });
  r.patch("/crm/reminders/:id", MANAGE, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id")); const b = await parseJson(c, z.object({ status: z.enum(["done", "cancelled"]) }));
    await tx(p, async (q) => { const x = await q.query("update service_reminders set status = $2 where id = $1", [id, b.status]); if (x.rowCount !== 1) throw notFound("reminder_not_found"); });
    return c.json({ ok: true });
  });

  // ===== Campanhas (somente com consentimento) =====
  const Audience = z.object({ kind: z.enum(["inactive", "quote_recovery", "reminders", "custom"]), params: z.object({ inactiveDays: z.number().int().min(30).max(1825).default(180), staleDays: z.number().int().min(1).max(90).default(3), daysAhead: z.number().int().min(0).max(60).default(7) }).default({ inactiveDays: 180, staleDays: 3, daysAhead: 7 }) });
  type Cand = { id: string; email: string | null; marketing_opt_in: boolean; unit_id: string | null };
  const audience = async (q: Q, a: z.infer<typeof Audience>): Promise<Cand[]> => {
    const base = "select distinct c.id, c.email::text email, c.marketing_opt_in, (select o2.unit_id from service_orders o2 where o2.tenant_id = c.tenant_id and o2.customer_id = c.id order by o2.created_at desc limit 1) unit_id from customers c";
    if (a.kind === "inactive") return q.many<Cand>(`${base} where exists (select 1 from service_orders o where o.tenant_id = c.tenant_id and o.customer_id = c.id and o.status = 'delivered')
      and not exists (select 1 from service_orders o where o.tenant_id = c.tenant_id and o.customer_id = c.id and (o.status = 'open' or o.created_at > now() - make_interval(days => $1::int)))`, [a.params.inactiveDays]);
    if (a.kind === "quote_recovery") return q.many<Cand>(`${base} where exists (select 1 from service_orders o join estimates e on e.tenant_id = o.tenant_id and e.os_id = o.id join estimate_versions v on v.tenant_id = e.tenant_id and v.estimate_id = e.id and v.status = 'published'
        where o.tenant_id = c.tenant_id and o.customer_id = c.id and o.status = 'open' and v.published_at < now() - make_interval(days => $1::int)
          and not exists (select 1 from approvals ap where ap.tenant_id = v.tenant_id and ap.version_id = v.id))`, [a.params.staleDays]);
    if (a.kind === "reminders") return q.many<Cand>(`${base} where exists (select 1 from service_reminders r where r.tenant_id = c.tenant_id and r.customer_id = c.id and r.status = 'pending' and r.due_date <= ${TODAY} + $1::int)`, [a.params.daysAhead]);
    return q.many<Cand>(base);
  };
  const split = (cands: Cand[]) => ({ eligible: cands.filter((x) => x.marketing_opt_in && x.email), noConsent: cands.filter((x) => !x.marketing_opt_in), noContact: cands.filter((x) => x.marketing_opt_in && !x.email) });
  r.post("/crm/campaigns/preview", CAMP, async (c) => {
    const p = c.get("tenant"); const a = await parseJson(c, Audience);
    return c.json(await tx(p, async (q) => { const s = split(await audience(q, a)); return { total: s.eligible.length + s.noConsent.length + s.noContact.length, eligible: s.eligible.length, excludedNoConsent: s.noConsent.length, excludedNoContact: s.noContact.length }; }));
  });
  r.post("/crm/campaigns", CAMP, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, Audience.extend({ name: z.string().trim().min(2).max(80) }));
    return c.json(await tx(p, async (q) => {
      const camp = (await q.one<{ id: string }>("insert into campaigns (tenant_id, name, kind, params, created_by) values ($1,$2,$3,$4,$5) returning id", [p.tenantId, b.name, b.kind, JSON.stringify(b.params), p.userId]))!;
      const s = split(await audience(q, b)); const defUnit = (await q.one<{ id: string }>("select id from units order by is_default desc, created_at limit 1"))?.id;
      for (const x of s.noConsent) await q.query("insert into campaign_recipients (tenant_id, campaign_id, customer_id, status, reason) values ($1,$2,$3,'skipped','no_consent') on conflict do nothing", [p.tenantId, camp.id, x.id]);
      for (const x of s.noContact) await q.query("insert into campaign_recipients (tenant_id, campaign_id, customer_id, status, reason) values ($1,$2,$3,'skipped','no_contact') on conflict do nothing", [p.tenantId, camp.id, x.id]);
      let queued = 0;
      for (const x of s.eligible) {
        const unit = x.unit_id ?? defUnit; if (!unit) continue;
        await q.query("insert into campaign_recipients (tenant_id, campaign_id, customer_id, status) values ($1,$2,$3,'queued')", [p.tenantId, camp.id, x.id]);
        await q.query("insert into outbox (tenant_id, unit_id, kind, payload) values ($1,$2,'campaign',$3)", [p.tenantId, unit, JSON.stringify({ customerId: x.id, campaignId: camp.id, title: b.name })]);
        queued++;
      }
      if (b.kind === "reminders") await q.query(`update service_reminders set status = 'queued' where status = 'pending' and due_date <= ${TODAY} + $1::int and customer_id in (select customer_id from campaign_recipients where campaign_id = $2 and status = 'queued')`, [b.params.daysAhead, camp.id]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "campaign.create", entityType: "campaign", entityId: camp.id, requestId: c.get("requestId") });
      return { id: camp.id, queued, skippedNoConsent: s.noConsent.length, skippedNoContact: s.noContact.length };
    }), 201);
  });
  r.get("/crm/campaigns", READ, async (c) => c.json({ campaigns: await tx(c.get("tenant"), (q) => q.many(`select c.id, c.name, c.kind, c.created_at, count(*) filter (where r.status = 'queued')::int queued, count(*) filter (where r.status = 'skipped')::int skipped from campaigns c left join campaign_recipients r on r.campaign_id = c.id group by c.id order by c.created_at desc limit 100`)) }));

  // ===== Satisfação =====
  r.post("/crm/orders/:id/satisfaction", MANAGE, async (c) => {
    const p = c.get("tenant"); const osId = uuid.parse(c.req.param("id")); const b = await parseJson(c, z.object({ score: z.number().int().min(0).max(10), comment: z.string().trim().max(500).optional() }));
    return c.json(await tx(p, async (q) => {
      const o = await q.one<{ unit_id: string; customer_id: string; status: string }>("select unit_id, customer_id, status from service_orders where id = $1", [osId]); if (!o) throw notFound("order_not_found");
      if (o.status !== "delivered") throw conflict("order_not_delivered");
      try { return await q.one("insert into satisfaction_surveys (tenant_id, unit_id, os_id, customer_id, score, comment, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id", [p.tenantId, o.unit_id, osId, o.customer_id, b.score, b.comment ?? null, p.userId]); }
      catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("already_rated"); throw e; }
    }), 201);
  });

  // ===== Métricas (receita reconcilia com o ledger) =====
  r.get("/crm/metrics", READ, async (c) => {
    const p = c.get("tenant"); const from = date.parse(c.req.query("from") ?? "2000-01-01"); const to = date.parse(c.req.query("to") ?? "2999-12-31");
    return c.json(await tx(p, async (q) => {
      const L = await q.one<{ total: string; converted: string; won: string }>("select count(*) total, count(converted_at) converted, count(*) filter (where status = 'won') won from leads where created_at::date between $1 and $2", [from, to]);
      const byCampaign = await q.many<{ campaign: string | null; source: string; leads: string; converted: string }>("select campaign, source, count(*) leads, count(converted_at) converted from leads where created_at::date between $1 and $2 group by campaign, source order by leads desc", [from, to]);
      const ids = (await q.many<{ id: string }>("select converted_order_id id from leads where converted_order_id is not null and created_at::date between $1 and $2", [from, to])).map((x) => x.id);
      const ledgerNet = await q.one<{ s: string }>(`select coalesce(sum(case when a.type = 'revenue' then (case e.side when 'C' then e.amount_cents else -e.amount_cents end) when a.type = 'deduction' then (case e.side when 'D' then -e.amount_cents else e.amount_cents end) else 0 end),0)::bigint s
          from ledger_txns t join ledger_entries e on e.tenant_id = t.tenant_id and e.txn_id = t.id join fin_accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id where t.os_id = any($1::uuid[])`, [ids]);
      const docs = await q.one<{ s: string }>("select coalesce(sum(net_cents),0)::bigint s from fin_documents where kind = 'receivable' and cancelled_at is null and os_id = any($1::uuid[])", [ids]);
      const camp = await q.one<{ queued: string; skipped: string }>("select count(*) filter (where status = 'queued') queued, count(*) filter (where status = 'skipped') skipped from campaign_recipients where created_at::date between $1 and $2", [from, to]);
      const sat = await q.one<{ n: string; prom: string; det: string; avg: string }>("select count(*) n, count(*) filter (where score >= 9) prom, count(*) filter (where score <= 6) det, coalesce(avg(score),0) avg from satisfaction_surveys where created_at::date between $1 and $2", [from, to]);
      const total = N(L!.total); const sn = N(sat!.n);
      return { leads: { total, converted: N(L!.converted), won: N(L!.won), conversionRate: total ? N(L!.converted) / total : 0, byCampaign: byCampaign.map((x) => ({ campaign: x.campaign, source: x.source, leads: N(x.leads), converted: N(x.converted) })) },
        revenueGeneratedCents: N(ledgerNet!.s), invoicedCents: N(docs!.s), reconciled: N(ledgerNet!.s) === N(docs!.s), convertedOrders: ids.length,
        campaigns: { queued: N(camp!.queued), skippedNoConsentOrContact: N(camp!.skipped) },
        satisfaction: { responses: sn, average: Number(sat!.avg), nps: sn ? Math.round(((N(sat!.prom) - N(sat!.det)) / sn) * 100) : null } };
    }));
  });
  void optOutPath;
}
