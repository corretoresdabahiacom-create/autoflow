// Primitivas baseadas em WebCrypto (Node 22 e Cloudflare Workers).

const enc = new TextEncoder();

export function toB64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function fromB64(s: string): Uint8Array {
  return fromB64Url(s.replace(/\+/g, "-").replace(/\//g, "_"));
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Token opaco de 256 bits (CSPRNG). Só o hash vai para o banco. */
export function randomToken(bytes = 32): string {
  return toB64Url(randomBytes(bytes));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function hashIp(ip: string, salt: string): Promise<string> {
  return (await sha256Hex(`${salt}:${ip}`)).slice(0, 32);
}

// ---------- AES-256-GCM (segredos por usuário/tenant em repouso) ----------
async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("APP_ENCRYPTION_KEY deve ter 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string, keyRaw: Uint8Array): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, await aesKey(keyRaw), enc.encode(plain));
  return `v1.${toB64Url(iv)}.${toB64Url(new Uint8Array(ct))}`;
}

export async function decryptSecret(blob: string, keyRaw: Uint8Array): Promise<string> {
  const [v, iv, ct] = blob.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("formato de segredo inválido");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64Url(iv) as BufferSource },
    await aesKey(keyRaw),
    fromB64Url(ct) as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

// ---------- TOTP (RFC 6238, SHA-1, 6 dígitos, passo de 30 s) ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("base32 inválido");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export async function totpAtStep(secretB32: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secretB32) as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = mac[mac.length - 1]! & 15;
  const bin =
    ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}

export const totpStepNow = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / 30);

/** Retorna o passo aceito (para impedir reuso do mesmo código) ou null. Janela ±1 passo. */
export async function verifyTotp(
  secretB32: string,
  code: string,
  lastStep: number | null,
  nowMs = Date.now(),
): Promise<number | null> {
  const cur = totpStepNow(nowMs);
  for (const step of [cur - 1, cur, cur + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = await totpAtStep(secretB32, step);
    if (constantTimeEqual(enc.encode(expected), enc.encode(code))) return step;
  }
  return null;
}

export function totpUri(account: string, secretB32: string, issuer = "AutoFlow"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
