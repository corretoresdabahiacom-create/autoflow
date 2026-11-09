import { decryptSecret, encryptSecret, newTotpSecret, sha256Hex, totpUri, verifyTotp } from "./crypto";
import { HttpError, unauthorized } from "./http";
import { dummyVerify, hashPassword, verifyPassword } from "./password";
import { enforceRateLimit } from "./ratelimit";
import type { Deps } from "./types";

export type AccountTable = "users" | "platform_users"; // lista fechada: nunca vem de entrada externa

const FAIL_LOCK_THRESHOLD = 5;

/** Bloqueio progressivo: 1 min após a 5ª falha, dobrando a cada falha extra, máx. 24 h. */
export function lockMinutes(failures: number): number {
  if (failures < FAIL_LOCK_THRESHOLD) return 0;
  return Math.min(2 ** (failures - FAIL_LOCK_THRESHOLD), 24 * 60);
}

async function registerFailure(deps: Deps, table: AccountTable, id: string): Promise<void> {
  await deps.db.system(async (q) => {
    const r = await q.one<{ failed_logins: number }>(
      `update ${table} set failed_logins = failed_logins + 1 where id = $1 returning failed_logins`,
      [id],
    );
    const mins = lockMinutes(r?.failed_logins ?? 0);
    if (mins > 0) {
      await q.query(`update ${table} set locked_until = now() + make_interval(mins => $2) where id = $1`, [id, mins]);
    }
  });
}

export interface LoginOk {
  id: string;
  mfaEnabled: boolean;
}

/** Verifica e-mail+senha com rate limit, lockout e resposta uniforme (sem enumeração de contas). */
export async function checkPassword(
  deps: Deps,
  table: AccountTable,
  email: string,
  password: string,
  ipHash: string,
): Promise<LoginOk> {
  const emailKey = await sha256Hex(`${table}:${email.toLowerCase()}`);
  await enforceRateLimit(deps.db, [
    [`login:ip:${ipHash}`, 30, 900],
    [`login:acct:${emailKey}`, 10, 900],
  ]);
  const row = await deps.db.system((q) =>
    q.one<{
      id: string;
      password_hash: string | null;
      status: string;
      locked_until: Date | null;
      mfa_enabled: boolean;
    }>(`select id, password_hash, status, locked_until, mfa_enabled from ${table} where email = $1`, [email]),
  );
  if (!row || !row.password_hash || row.status !== "active") {
    await dummyVerify(password, deps.config.scryptLogN);
    throw unauthorized("invalid_credentials");
  }
  if (row.locked_until && row.locked_until.getTime() > Date.now()) {
    const secs = Math.ceil((row.locked_until.getTime() - Date.now()) / 1000);
    throw new HttpError(429, "account_locked", undefined, { "Retry-After": String(Math.min(secs, 86400)) });
  }
  const res = await verifyPassword(password, row.password_hash, deps.config.scryptLogN);
  if (!res.ok) {
    await registerFailure(deps, table, row.id);
    throw unauthorized("invalid_credentials");
  }
  if (res.needsRehash) {
    const fresh = await hashPassword(password, deps.config.scryptLogN);
    await deps.db.system((q) => q.query(`update ${table} set password_hash = $2 where id = $1`, [row.id, fresh]));
  }
  return { id: row.id, mfaEnabled: row.mfa_enabled };
}

export async function markLoginSuccess(deps: Deps, table: AccountTable, id: string): Promise<void> {
  await deps.db.system((q) =>
    q.query(`update ${table} set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1`, [id]),
  );
}

/** Confere código TOTP com proteção a replay; falha conta para o lockout. */
export async function checkMfaCode(deps: Deps, table: AccountTable, id: string, code: string): Promise<void> {
  await enforceRateLimit(deps.db, [[`mfa:${table}:${id}`, 10, 900]]);
  const row = await deps.db.system((q) =>
    q.one<{ mfa_secret_enc: string | null; mfa_last_step: string | null; mfa_enabled: boolean }>(
      `select mfa_secret_enc, mfa_last_step, mfa_enabled from ${table} where id = $1`,
      [id],
    ),
  );
  if (!row?.mfa_secret_enc) throw unauthorized("mfa_not_enrolled");
  const secret = await decryptSecret(row.mfa_secret_enc, deps.config.encryptionKey);
  const last = row.mfa_last_step === null ? null : Number(row.mfa_last_step);
  const step = await verifyTotp(secret, code, last);
  if (step === null) {
    await registerFailure(deps, table, id);
    throw unauthorized("invalid_mfa_code");
  }
  const upd = await deps.db.system((q) =>
    q.query(`update ${table} set mfa_last_step = $2 where id = $1 and (mfa_last_step is null or mfa_last_step < $2)`, [id, step]),
  );
  if (upd.rowCount !== 1) throw unauthorized("invalid_mfa_code"); // replay
}

export async function startMfaEnrollment(
  deps: Deps,
  table: AccountTable,
  id: string,
  email: string,
): Promise<{ secret: string; uri: string }> {
  const secret = newTotpSecret();
  const enc = await encryptSecret(secret, deps.config.encryptionKey);
  await deps.db.system((q) =>
    q.query(`update ${table} set mfa_secret_enc = $2, mfa_enabled = false, mfa_last_step = null where id = $1`, [id, enc]),
  );
  return { secret, uri: totpUri(email, secret) };
}

/** Ativa o MFA após o primeiro código válido. */
export async function confirmMfaEnrollment(deps: Deps, table: AccountTable, id: string, code: string): Promise<void> {
  await checkMfaCode(deps, table, id, code);
  await deps.db.system((q) => q.query(`update ${table} set mfa_enabled = true where id = $1`, [id]));
}
