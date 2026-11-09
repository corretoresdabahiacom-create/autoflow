import { SLUG_PATTERN } from "@autoflow/shared";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { audit } from "../audit";
import { checkMfaCode, checkPassword, confirmMfaEnrollment, markLoginSuccess, startMfaEnrollment } from "../authcore";
import { randomToken, sha256Hex } from "../crypto";
import { HttpError, conflict, forbidden, notFound, parseJson } from "../http";
import type { Router } from "../router";
import { cookieNames, createSession, revokeSession } from "../sessions";
import type { Deps } from "../types";

const email = z.string().trim().toLowerCase().email().max(254);
const CodeBody = z.object({ code: z.string().regex(/^\d{6}$/) });
const LoginBody = z.object({ email, password: z.string().min(1).max(256) });
const ProvisionBody = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().regex(SLUG_PATTERN),
  planCode: z.string().min(2).max(40),
  ownerEmail: email,
});
const StatusBody = z.object({ reason: z.string().trim().min(10).max(500) });
const OverrideBody = z.object({
  featureCode: z.string().min(2).max(60),
  value: z.union([z.boolean(), z.number().int().min(0), z.null()]),
  reason: z.string().trim().min(10).max(500),
});
const GrantBody = z.object({
  tenantId: z.string().uuid(),
  reason: z.string().trim().min(15).max(500),
  scope: z.array(z.enum(["tenant", "units", "members", "audit", "usage"])).min(1),
  minutes: z.number().int().min(5).max(240),
});

export function registerPlatformRoutes(r: Router, deps: Deps): void {
  const names = cookieNames(deps.config);
  const cookieOpts = (maxAgeSec: number) =>
    ({ httpOnly: true, secure: deps.config.cookieSecure, sameSite: "Lax", path: "/", maxAge: maxAgeSec }) as const;
  const pctx = { actor: "platform" } as const;

  // ---- Autenticação do Super Admin (MFA obrigatório) ----
  r.post("/platform/auth/login", { auth: "public" }, async (c) => {
    const body = await parseJson(c, LoginBody);
    const ipHash = c.get("ipHash");
    const acct = await checkPassword(deps, "platform_users", body.email, body.password, ipHash);
    const token = await deps.db.system(async (q) => {
      const t = await createSession(q, {
        platformUserId: acct.id,
        idleMinutes: deps.config.platformSessionIdleMinutes,
        absoluteHours: deps.config.platformSessionAbsoluteHours,
        mfaVerified: false, // sessão só ganha acesso após o código TOTP
        ipHash,
        userAgent: c.req.header("user-agent"),
      });
      await audit(q, { actorType: "platform_user", actorId: acct.id, action: "platform.login_password_ok", requestId: c.get("requestId"), ipHash });
      return t;
    });
    setCookie(c, names.platform, token, cookieOpts(deps.config.platformSessionAbsoluteHours * 3600));
    return c.json({ ok: true, mfaEnrolled: acct.mfaEnabled, next: acct.mfaEnabled ? "verify" : "enroll" });
  });

  r.post("/platform/auth/mfa/enroll", { auth: "platform", mfa: "enroll" }, async (c) => {
    const p = c.get("platform");
    const u = await deps.db.system((q) => q.one<{ email: string; mfa_enabled: boolean }>("select email, mfa_enabled from platform_users where id = $1", [p.platformUserId]));
    if (!u) throw forbidden();
    if (u.mfa_enabled) throw conflict("mfa_already_enabled");
    return c.json(await startMfaEnrollment(deps, "platform_users", p.platformUserId, u.email));
  });

  const grantMfa = async (sessionId: string) =>
    deps.db.system((q) => q.query("update sessions set mfa_verified_at = now() where id = $1", [sessionId]));

  r.post("/platform/auth/mfa/confirm", { auth: "platform", mfa: "enroll" }, async (c) => {
    const p = c.get("platform");
    const { code } = await parseJson(c, CodeBody);
    await confirmMfaEnrollment(deps, "platform_users", p.platformUserId, code);
    await grantMfa(p.sessionId);
    await markLoginSuccess(deps, "platform_users", p.platformUserId);
    await deps.db.system((q) => audit(q, { actorType: "platform_user", actorId: p.platformUserId, action: "platform.mfa_enrolled", requestId: c.get("requestId") }));
    return c.json({ ok: true });
  });

  // Também serve para reautenticação (ações sensíveis exigem MFA recente).
  r.post("/platform/auth/mfa/verify", { auth: "platform", mfa: "enroll" }, async (c) => {
    const p = c.get("platform");
    const { code } = await parseJson(c, CodeBody);
    await checkMfaCode(deps, "platform_users", p.platformUserId, code);
    await grantMfa(p.sessionId);
    await markLoginSuccess(deps, "platform_users", p.platformUserId);
    await deps.db.system((q) => audit(q, { actorType: "platform_user", actorId: p.platformUserId, action: "platform.login_mfa_ok", requestId: c.get("requestId") }));
    return c.json({ ok: true });
  });

  r.post("/platform/auth/logout", { auth: "platform", mfa: "enroll" }, async (c) => {
    await deps.db.system((q) => revokeSession(q, c.get("platform").sessionId));
    deleteCookie(c, names.platform, { path: "/", secure: deps.config.cookieSecure });
    return c.json({ ok: true });
  });

  // ---- Tenants ----
  r.get("/platform/tenants", { auth: "platform", mfa: "verified" }, async (c) => {
    const rows = await deps.db.tx(pctx, (q) =>
      q.many(
        `select t.id, t.name, t.slug, t.status, s.status as subscription_status, p.code as plan
           from tenants t left join subscriptions s on s.tenant_id = t.id left join plans p on p.id = s.plan_id
          order by t.created_at desc limit 200`,
      ),
    );
    return c.json({ tenants: rows });
  });

  r.post("/platform/tenants", { auth: "platform", mfa: "recent" }, async (c) => {
    const p = c.get("platform");
    const body = await parseJson(c, ProvisionBody);
    const tenantId = crypto.randomUUID();
    const unitId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const token = randomToken(32);
    const tokenHash = await sha256Hex(token);
    await deps.db.tx(pctx, async (q) => {
      const plan = await q.one<{ id: string }>("select id from plans where code = $1", [body.planCode]);
      if (!plan) throw notFound("plan_not_found");
      const ownerRole = await q.one<{ id: string }>("select id from roles where tenant_id is null and key = 'owner'");
      try {
        await q.query("insert into tenants (id, name, slug) values ($1,$2,$3)", [tenantId, body.name, body.slug]);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "23505") throw conflict("slug_taken");
        if (code === "23514") throw new HttpError(422, "slug_reserved");
        throw e;
      }
      await q.query("insert into units (id, tenant_id, name, code, is_default) values ($1,$2,'Matriz','MATRIZ', true)", [unitId, tenantId]);
      await q.query("insert into subscriptions (tenant_id, plan_id, status, trial_ends_at) values ($1,$2,'trial', now() + interval '14 days')", [tenantId, plan.id]);
      let user = await q.one<{ id: string }>("select id from users where email = $1", [body.ownerEmail]);
      if (!user) user = await q.one<{ id: string }>("insert into users (email) values ($1) returning id", [body.ownerEmail]);
      await q.query("insert into memberships (id, tenant_id, user_id, role_id, all_units) values ($1,$2,$3,$4,true)", [membershipId, tenantId, user!.id, ownerRole!.id]);
      await q.query(
        "insert into auth_tokens (kind, token_hash, user_id, tenant_id, membership_id, expires_at) values ('invite',$1,$2,$3,$4, now() + interval '72 hours')",
        [tokenHash, user!.id, tenantId, membershipId],
      );
      await audit(q, { tenantId, actorType: "platform_user", actorId: p.platformUserId, action: "tenant.provision", entityType: "tenant", entityId: tenantId, requestId: c.get("requestId"), metadata: { plan: body.planCode } });
    });
    try {
      await deps.email.send({ to: body.ownerEmail, template: "invite", vars: { token } });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
    return c.json({ tenantId, ...(deps.config.exposeDevTokens ? { devToken: token } : {}) }, 201);
  });

  const setStatus = (target: "suspended" | "active") => async (c: import("hono").Context<import("../types").AppEnv>) => {
    const p = c.get("platform");
    const id = z.string().uuid().parse(c.req.param("id"));
    const { reason } = await parseJson(c, StatusBody);
    await deps.db.tx(pctx, async (q) => {
      const t = await q.one<{ status: string }>("select status from tenants where id = $1 for update", [id]);
      if (!t) throw notFound("tenant_not_found");
      if (target === "suspended") {
        await q.query("update tenants set status = 'suspended', suspended_reason = $2, updated_at = now() where id = $1", [id, reason]);
        await q.query("update subscriptions set status = 'suspended' where tenant_id = $1", [id]);
        // Corta o acesso imediatamente: revoga as sessões do tenant.
        await q.query("update sessions set revoked_at = now() where tenant_id = $1 and revoked_at is null", [id]);
      } else {
        await q.query("update tenants set status = 'active', suspended_reason = null, updated_at = now() where id = $1", [id]);
        await q.query("update subscriptions set status = 'active' where tenant_id = $1", [id]);
      }
      await audit(q, { tenantId: id, actorType: "platform_user", actorId: p.platformUserId, action: target === "suspended" ? "tenant.block" : "tenant.reactivate", entityType: "tenant", entityId: id, requestId: c.get("requestId"), metadata: { reason } });
    });
    return c.json({ ok: true });
  };
  r.post("/platform/tenants/:id/block", { auth: "platform", mfa: "recent" }, setStatus("suspended"));
  r.post("/platform/tenants/:id/reactivate", { auth: "platform", mfa: "recent" }, setStatus("active"));

  r.get("/platform/plans", { auth: "platform", mfa: "verified" }, async (c) => {
    const rows = await deps.db.tx(pctx, (q) =>
      q.many(
        `select p.code, p.name, coalesce(jsonb_object_agg(pf.feature_code, pf.value) filter (where pf.feature_code is not null), '{}') as features
           from plans p left join plan_features pf on pf.plan_id = p.id group by p.id order by p.code`,
      ),
    );
    return c.json({ plans: rows });
  });

  r.put("/platform/tenants/:id/overrides", { auth: "platform", mfa: "recent" }, async (c) => {
    const p = c.get("platform");
    const id = z.string().uuid().parse(c.req.param("id"));
    const body = await parseJson(c, OverrideBody);
    await deps.db.tx(pctx, async (q) => {
      const f = await q.one("select 1 from features where code = $1", [body.featureCode]);
      if (!f) throw notFound("feature_not_found");
      await q.query(
        `insert into tenant_feature_overrides (tenant_id, feature_code, value, reason) values ($1,$2,$3::jsonb,$4)
         on conflict (tenant_id, feature_code) do update set value = excluded.value, reason = excluded.reason`,
        [id, body.featureCode, JSON.stringify(body.value), body.reason],
      );
      await audit(q, { tenantId: id, actorType: "platform_user", actorId: p.platformUserId, action: "tenant.override", entityType: "feature", entityId: body.featureCode, requestId: c.get("requestId"), metadata: { reason: body.reason } });
    });
    return c.json({ ok: true });
  });

  r.get("/platform/metrics", { auth: "platform", mfa: "verified" }, async (c) => {
    // Somente agregados técnicos; nenhum dado de negócio de tenant.
    const row = await deps.db.tx(pctx, (q) =>
      q.one(
        `select (select count(*) from tenants)::int as tenants,
                (select count(*) from tenants where status = 'suspended')::int as suspended,
                (select count(*) from subscriptions where status = 'trial')::int as trials`,
      ),
    );
    return c.json(row);
  });

  // ---- Acesso excepcional (grant com motivo, escopo, expiração e somente leitura) ----
  r.post("/platform/support/grants", { auth: "platform", mfa: "recent" }, async (c) => {
    const p = c.get("platform");
    const body = await parseJson(c, GrantBody);
    const grant = await deps.db.tx(pctx, async (q) => {
      const t = await q.one("select 1 from tenants where id = $1", [body.tenantId]);
      if (!t) throw notFound("tenant_not_found");
      const g = await q.query<{ id: string }>(
        `insert into support_access_grants (operator_id, tenant_id, reason, scope, expires_at)
         values ($1,$2,$3,$4, now() + make_interval(mins => $5)) returning id`,
        [p.platformUserId, body.tenantId, body.reason, body.scope, body.minutes],
      );
      await audit(q, { tenantId: body.tenantId, actorType: "platform_user", actorId: p.platformUserId, action: "support.grant_create", entityType: "support_grant", entityId: g.rows[0]?.id, requestId: c.get("requestId"), metadata: { scope: body.scope, minutes: body.minutes } });
      return g.rows[0];
    });
    return c.json(grant, 201);
  });

  r.post("/platform/support/grants/:id/revoke", { auth: "platform", mfa: "verified" }, async (c) => {
    const p = c.get("platform");
    const id = z.string().uuid().parse(c.req.param("id"));
    await deps.db.tx(pctx, async (q) => {
      const g = await q.one<{ tenant_id: string }>("update support_access_grants set revoked_at = now() where id = $1 and revoked_at is null returning tenant_id", [id]);
      if (!g) throw notFound("grant_not_found");
      await audit(q, { tenantId: g.tenant_id, actorType: "platform_user", actorId: p.platformUserId, action: "support.grant_revoke", entityType: "support_grant", entityId: id, requestId: c.get("requestId") });
    });
    return c.json({ ok: true });
  });

  /** Leitura de recurso do tenant SOMENTE via grant; a RLS valida escopo, validade e operador. */
  r.get("/platform/support/:grantId/:resource", { auth: "platform", mfa: "recent" }, async (c) => {
    const p = c.get("platform");
    const grantId = z.string().uuid().parse(c.req.param("grantId"));
    const resource = z.enum(["units", "members", "audit"]).parse(c.req.param("resource"));
    const sql = {
      units: "select id, name, code, is_default from units order by created_at",
      members: "select m.id, u.email, m.status from memberships m join users u on u.id = m.user_id order by m.created_at",
      audit: "select id, action, actor_type, created_at from audit_log order by id desc limit 100",
    }[resource];
    const g = await deps.db.tx(pctx, (q) => q.one<{ tenant_id: string }>("select tenant_id from support_access_grants where id = $1 and operator_id = $2", [grantId, p.platformUserId]));
    if (!g) throw forbidden("grant_invalid");
    const rows = await deps.db.tx({ actor: "support", tenantId: g.tenant_id, userId: p.platformUserId, grantId, readonly: true, unitScope: "all" }, async (q) => {
      // Cada leitura excepcional é auditada na mesma transação.
      await audit(q, { tenantId: g.tenant_id, actorType: "platform_user", actorId: p.platformUserId, action: "support.read", entityType: resource, entityId: grantId, requestId: c.get("requestId") });
      return q.many(sql);
    });
    return c.json({ rows });
  });
}
