import type { Config } from "./config";
import { randomToken, sha256Hex } from "./crypto";
import type { Db, Q } from "./db";
import type { SessionRow } from "./types";

export function cookieNames(config: Config) {
  const p = config.cookieSecure ? "__Host-" : "";
  return { tenant: `${p}af_session`, platform: `${p}af_psession`, portal: `${p}af_portal` };
}

export interface NewSession {
  userId?: string;
  platformUserId?: string;
  tenantId?: string;
  membershipId?: string;
  idleMinutes: number;
  absoluteHours: number;
  mfaVerified: boolean;
  ipHash: string;
  userAgent?: string;
}

/** Sempre gera token novo (nunca reutiliza => sem fixação de sessão). Só o hash é persistido. */
export async function createSession(q: Q, s: NewSession): Promise<string> {
  const token = randomToken(32);
  await q.query(
    `insert into sessions (token_hash, user_id, platform_user_id, tenant_id, membership_id,
        idle_expires_at, absolute_expires_at, mfa_verified_at, ip_hash, user_agent)
     values ($1,$2,$3,$4,$5, now() + make_interval(mins => $6), now() + make_interval(hours => $7),
        case when $8 then now() else null end, $9, $10)`,
    [
      await sha256Hex(token),
      s.userId ?? null,
      s.platformUserId ?? null,
      s.tenantId ?? null,
      s.membershipId ?? null,
      s.idleMinutes,
      s.absoluteHours,
      s.mfaVerified,
      s.ipHash,
      s.userAgent?.slice(0, 200) ?? null,
    ],
  );
  return token;
}

export async function loadSession(
  db: Db,
  token: string,
  kind: "tenant" | "platform",
  idleMinutes: number,
): Promise<SessionRow | null> {
  const hash = await sha256Hex(token);
  return db.system(async (q) => {
    const r = await q.one<{
      id: string;
      user_id: string | null;
      platform_user_id: string | null;
      tenant_id: string | null;
      membership_id: string | null;
      mfa_verified_at: Date | null;
      valid: boolean;
    }>(
      `select id, user_id, platform_user_id, tenant_id, membership_id, mfa_verified_at,
              (revoked_at is null and idle_expires_at > now() and absolute_expires_at > now()) as valid
       from sessions where token_hash = $1`,
      [hash],
    );
    if (!r || !r.valid) return null;
    if (kind === "tenant" && !r.user_id) return null;
    if (kind === "platform" && !r.platform_user_id) return null;
    await q.query(
      `update sessions
         set last_seen_at = now(),
             idle_expires_at = least(now() + make_interval(mins => $2), absolute_expires_at)
       where id = $1 and last_seen_at < now() - interval '1 minute'`,
      [r.id, idleMinutes],
    );
    return {
      id: r.id,
      userId: r.user_id,
      platformUserId: r.platform_user_id,
      tenantId: r.tenant_id,
      membershipId: r.membership_id,
      mfaVerifiedAt: r.mfa_verified_at,
    };
  });
}

export async function revokeSession(q: Q, id: string): Promise<void> {
  await q.query("update sessions set revoked_at = now() where id = $1 and revoked_at is null", [id]);
}
