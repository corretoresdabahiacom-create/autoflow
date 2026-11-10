import { DEFAULT_THEME, MANDATORY_BLOCKS, OPTIONAL_BLOCKS, type ThemeConfig, hasFeature, itemHash, resolveEntitlements, subscriptionAllowsUse, type FeatureValue, type SubscriptionStatus } from "@autoflow/shared";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { audit } from "../audit";
import { randomToken, sha256Hex } from "../crypto";
import type { DbContext, Q } from "../db";
import { HttpError, conflict, forbidden, notFound, parseJson, unauthorized } from "../http";
import { enforceRateLimit, bumpCounter } from "../ratelimit";
import type { Router } from "../router";
import { cookieNames } from "../sessions";
import { MAX_UPLOAD_BYTES, signFileUrl, validateUpload } from "../storage";
import { addTimeline } from "../timeline";
import type { AppEnv, Deps, PortalPrincipal } from "../types";
import { loadModel, present } from "./estimates";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const PRIVACY_NOTICE =
  "Seus dados são tratados pela oficina para executar o serviço contratado (LGPD). Para exercer seus direitos, fale com a oficina.";
const SIGNED_URL_TTL_SECONDS = 300;
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const pctx = (p: PortalPrincipal): DbContext => ({ actor: "tenant", tenantId: p.tenantId, unitScope: "list", unitIds: [p.unitId] });

export async function logAccess(q: Q, p: Pick<PortalPrincipal, "tenantId" | "unitId" | "osId" | "linkId">, event: string, ipHash: string, ua?: string) {
  await q.query(
    "insert into portal_access_log (tenant_id, unit_id, os_id, link_id, event, ip_hash, user_agent) values ($1,$2,$3,$4,$5,$6,$7)",
    [p.tenantId, p.unitId, p.osId, p.linkId, event, ipHash, ua?.slice(0, 120) ?? null],
  );
}

export async function newPortalLink(q: Q, tenantId: string, unitId: string, osId: string, userId: string | null, delivered: boolean) {
  const token = `${tenantId}.${randomToken(32)}`; // 256 bits de segredo
  const st = await q.one<{ link_ttl_days: number }>("select link_ttl_days from portal_settings");
  const days = delivered ? (st?.link_ttl_days ?? 90) : 180;
  const row = await q.one<{ id: string; expires_at: Date }>(
    `insert into portal_links (tenant_id, unit_id, os_id, token_hash, created_by, expires_at)
     values ($1,$2,$3,$4,$5, now() + make_interval(days => $6)) returning id, expires_at`,
    [tenantId, unitId, osId, await sha256Hex(token), userId, days],
  );
  return { token, id: row!.id, expiresAt: row!.expires_at };
}

/** Sessão do portal: cookie `tenantId.segredo`; nunca aceita identificador de OS vindo do cliente. */
async function authenticatePortal(c: Context<AppEnv>, deps: Deps): Promise<PortalPrincipal> {
  const raw = getCookie(c, cookieNames(deps.config).portal);
  const m = raw ? TOKEN_RE.exec(raw) : null;
  if (!m) throw unauthorized("session_expired");
  const tenantId = m[1]!;
  const hash = await sha256Hex(raw!);
  const out = await deps.db.tx({ actor: "tenant", tenantId, unitScope: "all" }, async (q) => {
    const s = await q.one<{ id: string; link_id: string; unit_id: string; os_id: string; ok: boolean }>(
      `select s.id, s.link_id, s.unit_id, s.os_id,
              (s.revoked_at is null and s.idle_expires_at > now() and s.absolute_expires_at > now()
               and l.revoked_at is null and l.expires_at > now()) as ok
         from portal_sessions s join portal_links l on l.tenant_id = s.tenant_id and l.id = s.link_id
        where s.token_hash = $1`,
      [hash],
    );
    if (!s || !s.ok) return null;
    const t = await q.one<{ status: string }>("select status from tenants where id = $1", [tenantId]);
    const sub = await q.one<{ status: SubscriptionStatus; plan_id: string }>("select status, plan_id from subscriptions where tenant_id = $1", [tenantId]);
    if (!t || t.status !== "active" || !sub || !subscriptionAllowsUse(sub.status)) return "blocked" as const;
    const pf = Object.fromEntries((await q.many<{ feature_code: string; value: FeatureValue }>("select feature_code, value from plan_features where plan_id = $1", [sub.plan_id])).map((r) => [r.feature_code, r.value]));
    const of = Object.fromEntries((await q.many<{ feature_code: string; value: FeatureValue }>("select feature_code, value from tenant_feature_overrides where tenant_id = $1", [tenantId])).map((r) => [r.feature_code, r.value]));
    if (!hasFeature(resolveEntitlements(pf, of, sub.status), "portal")) return "blocked" as const;
    await q.query(
      `update portal_sessions set idle_expires_at = least(now() + make_interval(mins => $2), absolute_expires_at) where id = $1`,
      [s.id, deps.config.portalSessionIdleMinutes],
    );
    return { sessionId: s.id, linkId: s.link_id, tenantId, unitId: s.unit_id, osId: s.os_id } satisfies PortalPrincipal;
  });
  if (out === "blocked") throw forbidden("portal_unavailable");
  if (!out) throw unauthorized("session_expired");
  return out;
}

const ExchangeBody = z.object({ token: z.string().min(40).max(120) });
const OtpVerifyBody = z.object({
  code: z.string().regex(/^\d{6}$/),
  versionNo: z.number().int().min(1),
  decisions: z.array(z.object({ itemId: z.string().uuid(), decision: z.enum(["approved", "rejected"]), justification: z.string().trim().max(500).optional() })).min(1).max(100),
});
const MessageBody = z.object({ body: z.string().trim().min(1).max(2000) });
const stripControl = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

export async function loadPublishedTheme(q: Q): Promise<ThemeConfig> {
  const t = await q.one<{ config: ThemeConfig }>("select config from portal_theme_versions where status = 'published'");
  return t?.config ?? DEFAULT_THEME;
}

export function registerPortalRoutes(r: Router, deps: Deps): void {
  const names = cookieNames(deps.config);

  // ---- Troca do token do link por sessão curta (token vem no corpo, nunca na URL/servidor de logs) ----
  r.post("/portal/session", { auth: "public" }, async (c) => {
    const body = await parseJson(c, ExchangeBody);
    const ipHash = c.get("ipHash");
    await enforceRateLimit(deps.db, [[`portal:exchange:${ipHash}`, 30, 900]]);
    const fail = async (code: string, os?: PortalPrincipal): Promise<never> => {
      const n = await bumpCounter(deps.db, `portal:fail:${ipHash}`, 900);
      if (n > 10) throw new HttpError(429, "rate_limited", undefined, { "Retry-After": "900" });
      await sleep(Math.min(deps.config.portalFailDelayBaseMs * 2 ** Math.max(0, n - 1), 3000)); // atraso progressivo
      void os;
      throw unauthorized(code);
    };
    const m = TOKEN_RE.exec(body.token);
    if (!m) return fail("invalid_link");
    const tenantId = m[1]!;
    const hash = await sha256Hex(body.token);
    const link = await deps.db.tx({ actor: "tenant", tenantId, unitScope: "all" }, (q) =>
      q.one<{ id: string; unit_id: string; os_id: string; revoked: boolean; expired: boolean }>(
        "select id, unit_id, os_id, revoked_at is not null as revoked, expires_at <= now() as expired from portal_links where token_hash = $1",
        [hash],
      ),
    );
    if (!link) return fail("invalid_link");
    if (link.revoked) return fail("link_revoked");
    if (link.expired) return fail("link_expired");

    const secret = `${tenantId}.${randomToken(32)}`;
    const p: PortalPrincipal = { sessionId: "", linkId: link.id, tenantId, unitId: link.unit_id, osId: link.os_id };
    await deps.db.tx({ actor: "tenant", tenantId, unitScope: "all" }, async (q) => {
      await q.query(
        `insert into portal_sessions (tenant_id, unit_id, os_id, link_id, token_hash, idle_expires_at, absolute_expires_at, ip_hash)
         values ($1,$2,$3,$4,$5, now() + make_interval(mins => $6), now() + make_interval(hours => $7), $8)`,
        [tenantId, link.unit_id, link.os_id, link.id, await sha256Hex(secret), deps.config.portalSessionIdleMinutes, deps.config.portalSessionAbsoluteHours, ipHash],
      );
      await q.query("update portal_links set last_used_at = now() where id = $1", [link.id]);
      await logAccess(q, p, "exchange", ipHash, c.req.header("user-agent"));
    });
    setCookie(c, names.portal, secret, { httpOnly: true, secure: deps.config.cookieSecure, sameSite: "Lax", path: "/", maxAge: deps.config.portalSessionAbsoluteHours * 3600 });
    return c.json({ ok: true });
  });

  r.post("/portal/logout", { auth: "public" }, async (c) => {
    const raw = getCookie(c, names.portal);
    const m = raw ? TOKEN_RE.exec(raw) : null;
    if (m) {
      await deps.db.tx({ actor: "tenant", tenantId: m[1]!, unitScope: "all" }, async (q) => {
        await q.query("update portal_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [await sha256Hex(raw!)]);
      });
    }
    deleteCookie(c, names.portal, { path: "/", secure: deps.config.cookieSecure });
    return c.json({ ok: true });
  });

  // ---- Leitura: tudo derivado da sessão (sem parâmetro de OS => sem IDOR por id) ----
  const portalAuth = async (c: Context<AppEnv>) => authenticatePortal(c, deps);

  r.get("/portal/order", { auth: "public" }, async (c) => {
    const p = await portalAuth(c);
    const out = await deps.db.tx(pctx(p), async (q) => {
      const theme = await loadPublishedTheme(q);
      const hidden = new Set(theme.hidden.filter((h) => (OPTIONAL_BLOCKS as readonly string[]).includes(h))); // obrigatórios ignorados SEMPRE
      const o = await q.one<{ number: number; status: string; promised_at: Date | null; plate: string; make: string | null; model: string | null; customer_name: string; tenant_name: string; unit_name: string }>(
        `select o.number, o.status, o.promised_at, v.plate, v.make, v.model, c.name as customer_name, t.name as tenant_name, u.name as unit_name
           from service_orders o join vehicles v on v.tenant_id = o.tenant_id and v.id = o.vehicle_id
           join customers c on c.tenant_id = o.tenant_id and c.id = o.customer_id
           join tenants t on t.id = o.tenant_id join units u on u.id = o.unit_id where o.id = $1`,
        [p.osId],
      );
      if (!o) throw notFound("order_not_found");
      const model = await loadModel(q, p.osId);
      const cur = model.versions.find((v) => v.status === "published");
      const result: Record<string, unknown> = {
        theme: { primaryColor: theme.primaryColor, accentColor: theme.accentColor ?? null, welcomeText: hidden.has("welcomeText") ? null : (theme.welcomeText ?? null), hidden: [...hidden] },
        orderInfo: { number: o.number, plate: o.plate, vehicle: [o.make, o.model].filter(Boolean).join(" "), customerFirstName: o.customer_name.split(" ")[0], promisedAt: o.promised_at },
        status: o.status,
        estimate: cur
          ? { versionNo: cur.version_no, totalCents: Number(cur.total_cents), items: cur.items.map(present).map((i) => ({ id: i.id, description: i.description, category: i.category, qty: i.qty, unitPriceCents: i.unitPriceCents, totalCents: i.totalCents, status: i.status })) }
          : null,
        shopContact: { name: o.tenant_name, unit: o.unit_name },
        privacyNotice: PRIVACY_NOTICE,
      };
      if (!hidden.has("timeline")) result.timeline = await q.many("select kind, title, created_at from os_timeline where os_id = $1 and visible_to_customer order by created_at", [p.osId]);
      if (!hidden.has("photos")) {
        const rows = await q.many<{ id: string; kind: string }>("select id, kind from attachments where os_id = $1 and portal_visible and kind in ('photo','entry_term') order by created_at", [p.osId]);
        result.files = await Promise.all(rows.map(async (a) => ({ id: a.id, kind: a.kind, url: await signFileUrl(deps.config.encryptionKey, p.tenantId, a.id, SIGNED_URL_TTL_SECONDS) })));
      }
      if (!hidden.has("chat")) result.messages = await q.many("select sender, body, created_at from portal_messages where os_id = $1 order by created_at", [p.osId]);
      await logAccess(q, p, "view", c.get("ipHash"), c.req.header("user-agent"));
      return result;
    });
    return c.json(out);
  });

  // ---- OTP + aprovação ----
  r.post("/portal/approval/otp", { auth: "public" }, async (c) => {
    const p = await portalAuth(c);
    await enforceRateLimit(deps.db, [[`portal:otp:${p.sessionId}`, 3, 600], [`portal:otp:os:${p.osId}`, 10, 3600]]);
    const target = await deps.db.tx(pctx(p), async (q) => {
      const model = await loadModel(q, p.osId);
      if (!model.versions.some((v) => v.status === "published")) throw conflict("no_published_version");
      return q.one<{ phone_e164: string | null; email: string | null }>(
        "select c.phone_e164, c.email from service_orders o join customers c on c.tenant_id = o.tenant_id and c.id = o.customer_id where o.id = $1", [p.osId]);
    });
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
    const otpId = crypto.randomUUID();
    const masked = await deps.otp.send({ phoneE164: target?.phone_e164 ?? null, email: target?.email ?? null }, code);
    await deps.db.tx(pctx(p), async (q) => {
      await q.query(
        `insert into portal_otps (id, tenant_id, unit_id, os_id, session_id, code_hash, channel, destination_masked, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(mins => $9))`,
        [otpId, p.tenantId, p.unitId, p.osId, p.sessionId, await sha256Hex(`${otpId}:${code}`), deps.otp.name, masked, OTP_TTL_MINUTES],
      );
      await logAccess(q, p, "otp_requested", c.get("ipHash"));
    });
    return c.json({ ok: true, destination: masked, expiresInMinutes: OTP_TTL_MINUTES, ...(deps.config.exposeDevTokens ? { devCode: code } : {}) });
  });

  r.post("/portal/approval", { auth: "public" }, async (c) => {
    const p = await portalAuth(c);
    const b = await parseJson(c, OtpVerifyBody);
    const ipHash = c.get("ipHash");
    const ua = (c.req.header("user-agent") ?? "").slice(0, 120);

    // 1) Verifica o OTP em transação própria (a contagem de tentativas precisa persistir mesmo na falha).
    const verdict = await deps.db.tx(pctx(p), async (q) => {
      const model = await loadModel(q, p.osId);
      const cur = model.versions.find((v) => v.status === "published");
      if (!cur) return { kind: "no_published_version" as const };
      if (cur.version_no !== b.versionNo) return { kind: "version_obsolete" as const };
      const otp = await q.one<{ id: string; code_hash: string; attempts: number; channel: string; destination_masked: string }>(
        `select id, code_hash, attempts, channel, destination_masked from portal_otps
          where session_id = $1 and used_at is null and expires_at > now() order by created_at desc limit 1 for update`,
        [p.sessionId],
      );
      if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) return { kind: "otp_invalid" as const };
      if ((await sha256Hex(`${otp.id}:${b.code}`)) !== otp.code_hash) {
        await q.query("update portal_otps set attempts = attempts + 1 where id = $1", [otp.id]);
        await logAccess(q, p, "otp_failed", ipHash);
        return { kind: "otp_invalid" as const };
      }
      return { kind: "ok" as const, otp };
    });
    if (verdict.kind === "no_published_version") throw conflict("no_published_version");
    if (verdict.kind === "version_obsolete") throw conflict("version_obsolete");
    if (verdict.kind === "otp_invalid") throw new HttpError(401, "invalid_otp");

    // 2) Registra decisões (OTP é consumido na mesma transação; uso único).
    const items = await deps.db.tx(pctx(p), async (q) => {
      const used = await q.query("update portal_otps set used_at = now() where id = $1 and used_at is null", [verdict.otp.id]);
      if (used.rowCount !== 1) throw new HttpError(401, "invalid_otp");
      const model = await loadModel(q, p.osId);
      const cur = model.versions.find((v) => v.status === "published");
      if (!cur || cur.version_no !== b.versionNo) throw conflict("version_obsolete");
      const byId = new Map(cur.items.map((i) => [i.id, i]));
      for (const d of b.decisions) {
        const it = byId.get(d.itemId);
        if (!it) throw new HttpError(422, "item_not_in_current_version");
        if (it.status !== "pending") throw conflict("already_decided");
        if (d.decision === "rejected" && (d.justification ?? "").length < 5) throw new HttpError(422, "justification_required");
        const recomputed = itemHash({ description: it.description, category: it.category, qty: Number(it.qty), unitPriceCents: Number(it.unit_price_cents) });
        if (recomputed !== it.item_hash) throw new HttpError(500, "item_integrity_failure");
      }
      const snapshot = cur.items.map((i) => ({ id: i.id, hash: i.item_hash, qty: Number(i.qty), unitPriceCents: Number(i.unit_price_cents) }));
      for (const d of b.decisions) {
        const it = byId.get(d.itemId)!;
        await q.query(
          `insert into approvals (tenant_id, unit_id, version_id, item_id, decision, item_hash_at_decision, channel, decided_by, justification, evidence)
           values ($1,$2,$3,$4,$5,$6,'portal',null,$7,$8)`,
          [p.tenantId, p.unitId, cur.id, it.id, d.decision, it.item_hash, d.justification ?? null,
            JSON.stringify({ procedure: "portal_otp", versionNo: cur.version_no, presentedHash: cur.presented_hash, totalCents: Number(cur.total_cents), items: snapshot,
              otpId: verdict.otp.id, otpChannel: verdict.otp.channel, otpDestination: verdict.otp.destination_masked, sessionId: p.sessionId, linkId: p.linkId, ipHash, userAgent: ua, at: new Date().toISOString() })],
        );
      }
      await addTimeline(q, { tenantId: p.tenantId, unitId: p.unitId, osId: p.osId, kind: "approval.portal", title: "Cliente respondeu ao orçamento pelo portal" });
      await audit(q, { tenantId: p.tenantId, actorType: "system", action: "portal.approval", entityType: "order", entityId: p.osId, ipHash, metadata: { versionNo: cur.version_no, count: b.decisions.length, channel: verdict.otp.channel } });
      await logAccess(q, p, "approval", ipHash, ua);
      return (await loadModel(q, p.osId)).versions.find((v) => v.status === "published")!.items.map(present);
    });
    return c.json({ items }, 201);
  });

  // ---- Chat do cliente ----
  r.post("/portal/messages", { auth: "public" }, async (c) => {
    const p = await portalAuth(c);
    await enforceRateLimit(deps.db, [[`portal:chat:${p.sessionId}`, 30, 3600]]);
    const theme = await deps.db.tx(pctx(p), (q) => loadPublishedTheme(q));
    if (theme.hidden.includes("chat")) throw forbidden("chat_disabled");
    const isMultipart = (c.req.header("content-type") ?? "").startsWith("multipart/form-data");
    let body: string; let file: File | null = null;
    if (isMultipart) {
      const form = await c.req.parseBody();
      body = MessageBody.parse({ body: typeof form["body"] === "string" ? form["body"] : "" }).body;
      const f = form["file"];
      if (f instanceof File) file = f;
    } else body = (await parseJson(c, MessageBody)).body;
    body = stripControl(body);
    let bytes: Uint8Array | null = null; let mime: ReturnType<typeof validateUpload> | null = null;
    if (file) {
      if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(422, "file_too_large");
      bytes = new Uint8Array(await file.arrayBuffer());
      mime = validateUpload(bytes, file.type || undefined);
    }
    const id = await deps.db.tx(pctx(p), async (q) => {
      const os = await q.one<{ status: string }>("select status from service_orders where id = $1", [p.osId]);
      if (!os) throw notFound("order_not_found");
      let attId: string | null = null;
      if (bytes && mime) {
        attId = crypto.randomUUID();
        const key = `${p.tenantId}/${p.osId}/${attId}`;
        const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (x) => x.toString(16).padStart(2, "0")).join("");
        await q.query(
          `insert into attachments (id, tenant_id, unit_id, os_id, kind, storage_key, mime, size_bytes, sha256, created_by, portal_visible)
           values ($1,$2,$3,$4,'document',$5,$6,$7,$8,null,true)`,
          [attId, p.tenantId, p.unitId, p.osId, key, mime, bytes.length, sha],
        );
        await deps.storage.put(key, bytes);
      }
      const m = await q.one<{ id: string }>(
        "insert into portal_messages (tenant_id, unit_id, os_id, sender, body, attachment_id) values ($1,$2,$3,'customer',$4,$5) returning id",
        [p.tenantId, p.unitId, p.osId, body, attId],
      );
      await logAccess(q, p, "chat_send", c.get("ipHash"));
      return m!.id;
    });
    return c.json({ id }, 201);
  });
}
