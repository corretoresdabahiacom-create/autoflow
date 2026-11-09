import { validatePassword } from "@autoflow/shared";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { audit } from "../audit";
import { checkMfaCode, checkPassword, confirmMfaEnrollment, markLoginSuccess, startMfaEnrollment } from "../authcore";
import { randomToken, sha256Hex } from "../crypto";
import { HttpError, badRequest, forbidden, parseJson, unauthorized } from "../http";
import { hashPassword } from "../password";
import { enforceRateLimit } from "../ratelimit";
import type { Router } from "../router";
import { cookieNames, createSession, revokeSession } from "../sessions";
import type { Deps } from "../types";

const email = z.string().trim().toLowerCase().email().max(254);
const slug = z.string().trim().toLowerCase().min(3).max(40);
const password = z.string().min(1).max(256);

const LoginBody = z.object({ email, password, tenantSlug: slug, mfaCode: z.string().regex(/^\d{6}$/).optional() });
const AcceptBody = z.object({ token: z.string().min(20).max(200), password });
const ForgotBody = z.object({ email, tenantSlug: slug });
const ResetBody = z.object({ token: z.string().min(20).max(200), password });
const CodeBody = z.object({ code: z.string().regex(/^\d{6}$/) });

const INVITE_HOURS = 72;
const RESET_MINUTES = 30;

export function registerAuthRoutes(r: Router, deps: Deps): void {
  const names = cookieNames(deps.config);
  const cookieOpts = (maxAgeSec: number) =>
    ({ httpOnly: true, secure: deps.config.cookieSecure, sameSite: "Lax", path: "/", maxAge: maxAgeSec }) as const;

  r.post("/auth/login", { auth: "public" }, async (c) => {
    const body = await parseJson(c, LoginBody);
    const ipHash = c.get("ipHash");
    const acct = await checkPassword(deps, "users", body.email, body.password, ipHash);

    // Resolve o vínculo com o tenant informado. Resposta uniforme se não houver vínculo ativo.
    const ctx = await deps.db.system(
      (q) => q.one<{ id: string; status: string }>("select id, status from tenants where slug = $1", [body.tenantSlug]),
      acct.id,
    );
    const membership = ctx
      ? await deps.db.tx({ actor: "tenant", tenantId: ctx.id, userId: acct.id, unitScope: "all" }, (q) =>
          q.one<{ id: string; status: string }>("select id, status from memberships where user_id = $1", [acct.id]),
        )
      : null;
    if (!ctx || !membership || membership.status !== "active" || ctx.status === "cancelled") {
      throw unauthorized("invalid_credentials");
    }

    if (acct.mfaEnabled) {
      if (!body.mfaCode) throw new HttpError(401, "mfa_required");
      await checkMfaCode(deps, "users", acct.id, body.mfaCode);
    }
    await markLoginSuccess(deps, "users", acct.id);
    const token = await deps.db.tx({ actor: "tenant", tenantId: ctx.id, userId: acct.id, unitScope: "all" }, async (q) => {
      const t = await createSession(q, {
        userId: acct.id,
        tenantId: ctx.id,
        membershipId: membership.id,
        idleMinutes: deps.config.tenantSessionIdleMinutes,
        absoluteHours: deps.config.tenantSessionAbsoluteHours,
        mfaVerified: acct.mfaEnabled,
        ipHash,
        userAgent: c.req.header("user-agent"),
      });
      await audit(q, { tenantId: ctx.id, actorType: "user", actorId: acct.id, action: "auth.login", requestId: c.get("requestId"), ipHash });
      return t;
    });
    setCookie(c, names.tenant, token, cookieOpts(deps.config.tenantSessionAbsoluteHours * 3600));
    return c.json({ ok: true });
  });

  r.post("/auth/logout", { auth: "session" }, async (c) => {
    const s = c.get("session");
    await deps.db.system((q) => revokeSession(q, s.id));
    deleteCookie(c, names.tenant, { path: "/", secure: deps.config.cookieSecure });
    return c.json({ ok: true });
  });

  r.get("/auth/me", { auth: "tenant", permission: "any-member" }, (c) => {
    const p = c.get("tenant");
    return c.json({
      userId: p.userId,
      tenantId: p.tenantId,
      role: p.roleKey,
      permissions: [...p.permissions].sort(),
      unitScope: p.unitScope,
      unitIds: p.unitIds,
    });
  });

  // ---- Convite: define a senha e ativa o vínculo ----
  r.post("/auth/invite/accept", { auth: "public" }, async (c) => {
    const body = await parseJson(c, AcceptBody);
    await enforceRateLimit(deps.db, [[`invite:ip:${c.get("ipHash")}`, 20, 900]]);
    const hash = await sha256Hex(body.token);
    const tok = await deps.db.system((q) =>
      q.one<{ id: string; user_id: string; tenant_id: string; membership_id: string; email: string }>(
        `select t.id, t.user_id, t.tenant_id, t.membership_id, u.email
           from auth_tokens t join users u on u.id = t.user_id
          where t.token_hash = $1 and t.kind = 'invite' and t.used_at is null and t.expires_at > now()`,
        [hash],
      ),
    );
    if (!tok) throw badRequest("invalid_or_expired_token");
    const problem = validatePassword(body.password, tok.email);
    if (problem) throw new HttpError(422, "weak_password", problem);
    const pwHash = await hashPassword(body.password, deps.config.scryptLogN);
    await deps.db.tx({ actor: "tenant", tenantId: tok.tenant_id, userId: tok.user_id, unitScope: "all" }, async (q) => {
      const used = await q.query("update auth_tokens set used_at = now() where id = $1 and used_at is null", [tok.id]);
      if (used.rowCount !== 1) throw badRequest("invalid_or_expired_token");
      await q.query("update users set password_hash = $2, failed_logins = 0, locked_until = null where id = $1", [tok.user_id, pwHash]);
      await q.query("update memberships set status = 'active' where id = $1 and status = 'invited'", [tok.membership_id]);
      await audit(q, { tenantId: tok.tenant_id, actorType: "user", actorId: tok.user_id, action: "auth.invite_accepted", requestId: c.get("requestId") });
    });
    return c.json({ ok: true });
  });

  // ---- Recuperação de senha (resposta sempre igual: sem enumeração) ----
  r.post("/auth/password/forgot", { auth: "public" }, async (c) => {
    const body = await parseJson(c, ForgotBody);
    const emailKey = await sha256Hex(`forgot:${body.email}`);
    await enforceRateLimit(deps.db, [
      [`forgot:ip:${c.get("ipHash")}`, 10, 3600],
      [`forgot:acct:${emailKey}`, 3, 3600],
    ]);
    const user = await deps.db.system((q) =>
      q.one<{ id: string; status: string }>("select id, status from users where email = $1", [body.email]),
    );
    let devToken: string | undefined;
    if (user && user.status === "active") {
      const token = randomToken(32);
      const h = await sha256Hex(token);
      await deps.db.system((q) =>
        q.query("update auth_tokens set used_at = now() where kind = 'password_reset' and user_id = $1 and used_at is null", [user.id]),
      );
      await deps.db.system((q) =>
        q.query(
          `insert into auth_tokens (kind, token_hash, user_id, expires_at)
           values ('password_reset', $1, $2, now() + make_interval(mins => $3))`,
          [h, user.id, RESET_MINUTES],
        ),
      );
      try {
        await deps.email.send({ to: body.email, template: "password_reset", vars: { token } });
      } catch (e) {
        if (!(e instanceof HttpError)) throw e; // provedor ausente: não revela existência da conta
      }
      if (deps.config.exposeDevTokens) devToken = token;
    }
    return c.json({ ok: true, ...(devToken ? { devToken } : {}) }, 202);
  });

  r.post("/auth/password/reset", { auth: "public" }, async (c) => {
    const body = await parseJson(c, ResetBody);
    await enforceRateLimit(deps.db, [[`reset:ip:${c.get("ipHash")}`, 20, 900]]);
    const hash = await sha256Hex(body.token);
    const tok = await deps.db.system((q) =>
      q.one<{ id: string; user_id: string; email: string }>(
        `select t.id, t.user_id, u.email from auth_tokens t join users u on u.id = t.user_id
          where t.token_hash = $1 and t.kind = 'password_reset' and t.used_at is null and t.expires_at > now()`,
        [hash],
      ),
    );
    if (!tok) throw badRequest("invalid_or_expired_token");
    const problem = validatePassword(body.password, tok.email);
    if (problem) throw new HttpError(422, "weak_password", problem);
    const pwHash = await hashPassword(body.password, deps.config.scryptLogN);
    await deps.db.system(async (q) => {
      const used = await q.query("update auth_tokens set used_at = now() where id = $1 and used_at is null", [tok.id]);
      if (used.rowCount !== 1) throw badRequest("invalid_or_expired_token");
      await q.query("update users set password_hash = $2, failed_logins = 0, locked_until = null where id = $1", [tok.user_id, pwHash]);
      // Reset invalida todas as sessões existentes.
      await q.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [tok.user_id]);
      await audit(q, { actorType: "user", actorId: tok.user_id, action: "auth.password_reset", requestId: c.get("requestId") });
    });
    return c.json({ ok: true });
  });

  // ---- MFA opcional para usuários de tenant ----
  r.post("/auth/mfa/enroll", { auth: "tenant", permission: "any-member" }, async (c) => {
    const p = c.get("tenant");
    const u = await deps.db.system((q) => q.one<{ email: string; mfa_enabled: boolean }>("select email, mfa_enabled from users where id = $1", [p.userId]));
    if (!u) throw forbidden();
    if (u.mfa_enabled) throw new HttpError(409, "mfa_already_enabled");
    return c.json(await startMfaEnrollment(deps, "users", p.userId, u.email));
  });

  r.post("/auth/mfa/confirm", { auth: "tenant", permission: "any-member" }, async (c) => {
    const p = c.get("tenant");
    const { code } = await parseJson(c, CodeBody);
    await confirmMfaEnrollment(deps, "users", p.userId, code);
    await deps.db.tx({ actor: "tenant", tenantId: p.tenantId, userId: p.userId, unitScope: "all" }, (q) =>
      audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "auth.mfa_enabled", requestId: c.get("requestId") }),
    );
    return c.json({ ok: true });
  });
}
