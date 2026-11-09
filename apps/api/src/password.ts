import { scryptAsync } from "@noble/hashes/scrypt.js";
import { constantTimeEqual, fromB64Url, randomBytes, toB64Url } from "./crypto";

// Formato: scrypt$<logN>$<r>$<p>$<salt>$<hash>. Parâmetros ficam no hash para permitir upgrade gradual.
const R = 8;
const P = 1;
const MAX_LOG_N = 20; // teto contra hash adulterado forçando custo absurdo

const utf8 = (s: string) => new TextEncoder().encode(s.normalize("NFKC"));

export async function hashPassword(password: string, logN: number): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(utf8(password), salt, { N: 2 ** logN, r: R, p: P, dkLen: 32 });
  return `scrypt$${logN}$${R}$${P}$${toB64Url(salt)}$${toB64Url(key)}`;
}

export interface VerifyResult {
  ok: boolean;
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string, targetLogN: number): Promise<VerifyResult> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return { ok: false, needsRehash: false };
  const logN = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(logN) || logN < 10 || logN > MAX_LOG_N || r !== R || p !== P) {
    return { ok: false, needsRehash: false };
  }
  const salt = fromB64Url(parts[4]!);
  const expected = fromB64Url(parts[5]!);
  const key = await scryptAsync(utf8(password), salt, { N: 2 ** logN, r, p, dkLen: expected.length });
  const ok = constantTimeEqual(key, expected);
  return { ok, needsRehash: ok && logN < targetLogN };
}

const dummyCache = new Map<number, string>();

/** Hash descartável para equalizar o tempo de resposta quando o usuário não existe. */
export async function dummyVerify(password: string, logN: number): Promise<void> {
  let h = dummyCache.get(logN);
  if (!h) {
    h = await hashPassword("dummy-password-never-valid", logN);
    dummyCache.set(logN, h);
  }
  await verifyPassword(password, h, logN);
}
