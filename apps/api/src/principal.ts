import {
  type FeatureValue,
  type SubscriptionStatus,
  resolveEntitlements,
  resolvePermissions,
  subscriptionAllowsUse,
} from "@autoflow/shared";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { forbidden, HttpError, unauthorized } from "./http";
import { cookieNames, loadSession } from "./sessions";
import type { AppEnv, Deps, PlatformPrincipal, SessionRow, TenantPrincipal } from "./types";

export async function sessionFromCookie(c: Context<AppEnv>, deps: Deps, kind: "tenant" | "platform"): Promise<SessionRow> {
  const names = cookieNames(deps.config);
  const token = getCookie(c, kind === "tenant" ? names.tenant : names.platform);
  if (!token) throw unauthorized();
  const idle = kind === "tenant" ? deps.config.tenantSessionIdleMinutes : deps.config.platformSessionIdleMinutes;
  const s = await loadSession(deps.db, token, kind, idle);
  if (!s) throw unauthorized("session_expired");
  return s;
}

/**
 * Pipeline de autorização do tenant (falha fechada):
 * sessão → membership ativa → tenant ativo → assinatura → permissões/unidades/entitlements.
 * O contexto de bootstrap usa unit_scope=all apenas para ler os vínculos do próprio usuário.
 */
export async function authenticateTenant(
  c: Context<AppEnv>,
  deps: Deps,
  opts: { allowInactive?: boolean },
): Promise<TenantPrincipal> {
  const s = await sessionFromCookie(c, deps, "tenant");
  if (!s.tenantId || !s.membershipId || !s.userId) throw unauthorized("session_without_tenant");
  const { tenantId, membershipId, userId } = s;

  return deps.db.tx({ actor: "tenant", tenantId, userId, unitScope: "all" }, async (q) => {
    const m = await q.one<{ role_id: string; status: string; all_units: boolean; role_key: string }>(
      `select m.role_id, m.status, m.all_units, r.key as role_key
         from memberships m join roles r on r.id = m.role_id
        where m.id = $1 and m.user_id = $2`,
      [membershipId, userId],
    );
    if (!m || m.status !== "active") throw forbidden("membership_inactive");

    const t = await q.one<{ status: string }>("select status from tenants where id = $1", [tenantId]);
    if (!t) throw forbidden("tenant_not_found");
    if ((t.status === "suspended" || t.status === "cancelled") && !opts.allowInactive) {
      throw forbidden("tenant_suspended");
    }

    const sub = await q.one<{ status: SubscriptionStatus; plan_id: string }>(
      "select status, plan_id from subscriptions where tenant_id = $1",
      [tenantId],
    );
    if (!sub) throw new HttpError(402, "no_subscription");
    if (!subscriptionAllowsUse(sub.status) && !opts.allowInactive) throw new HttpError(402, "subscription_inactive");

    const catalog = new Set((await q.many<{ code: string }>("select code from permissions")).map((r) => r.code));
    const rolePerms = (await q.many<{ permission_code: string }>(
      "select permission_code from role_permissions where role_id = $1",
      [m.role_id],
    )).map((r) => r.permission_code);
    const overrides = (await q.many<{ code: string; effect: "allow" | "deny" }>(
      "select permission_code as code, effect from membership_permission_overrides where membership_id = $1",
      [membershipId],
    ));
    const permissions = resolvePermissions(rolePerms, overrides, catalog);

    let unitIds: string[] = [];
    if (!m.all_units) {
      unitIds = (await q.many<{ unit_id: string }>(
        "select unit_id from unit_memberships where membership_id = $1",
        [membershipId],
      )).map((r) => r.unit_id);
    }

    const planF = Object.fromEntries(
      (await q.many<{ feature_code: string; value: FeatureValue }>(
        "select feature_code, value from plan_features where plan_id = $1",
        [sub.plan_id],
      )).map((r) => [r.feature_code, r.value]),
    );
    const overF = Object.fromEntries(
      (await q.many<{ feature_code: string; value: FeatureValue }>(
        "select feature_code, value from tenant_feature_overrides where tenant_id = $1",
        [tenantId],
      )).map((r) => [r.feature_code, r.value]),
    );

    return {
      kind: "tenant",
      sessionId: s.id,
      userId,
      tenantId,
      membershipId,
      roleKey: m.role_key,
      permissions,
      unitScope: m.all_units ? "all" : "list",
      unitIds,
      entitlements: resolveEntitlements(planF, overF, sub.status),
    } satisfies TenantPrincipal;
  });
}

export type PlatformMfaLevel = "enroll" | "verified" | "recent";

export async function authenticatePlatform(
  c: Context<AppEnv>,
  deps: Deps,
  level: PlatformMfaLevel,
): Promise<PlatformPrincipal> {
  const s = await sessionFromCookie(c, deps, "platform");
  const pu = await deps.db.system((q) =>
    q.one<{ status: string; mfa_enabled: boolean }>("select status, mfa_enabled from platform_users where id = $1", [s.platformUserId]),
  );
  if (!pu || pu.status !== "active") throw unauthorized("platform_user_disabled");

  if (level !== "enroll") {
    if (!s.mfaVerifiedAt) throw forbidden("mfa_required");
    if (level === "recent") {
      const ageMs = Date.now() - s.mfaVerifiedAt.getTime();
      if (ageMs > deps.config.platformMfaRecentMinutes * 60_000) throw forbidden("mfa_recent_required");
    }
  }
  return { kind: "platform", sessionId: s.id, platformUserId: s.platformUserId!, mfaVerifiedAt: s.mfaVerifiedAt };
}
