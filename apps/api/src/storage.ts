import { constantTimeEqual, sha256Hex } from "./crypto";
import { HttpError } from "./http";

export interface StorageProvider {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

/** Produção até existir o adaptador R2 (KI-015): falha explícita em vez de perder arquivos. */
export class UnconfiguredStorage implements StorageProvider {
  async put(): Promise<void> { throw new HttpError(503, "storage_not_configured"); }
  async get(): Promise<Uint8Array | null> { throw new HttpError(503, "storage_not_configured"); }
}

/** Dev/teste: guarda em memória. */
export class MemoryStorage implements StorageProvider {
  readonly files = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) { this.files.set(key, bytes); }
  async get(key: string) { return this.files.get(key) ?? null; }
}

/** Subconjunto estrutural do R2Bucket (evita depender de @cloudflare/workers-types). Bucket PRIVADO: nunca expor publicamente. */
export interface R2BucketLike {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}
const R2_KEY = /^[A-Za-z0-9][A-Za-z0-9._\-\/]{0,300}$/;
export class R2Storage implements StorageProvider {
  constructor(private readonly bucket: R2BucketLike) {}
  private check(key: string): string { if (!R2_KEY.test(key) || key.includes("..") || key.includes("//")) throw new Error("chave inválida"); return key; }
  async put(key: string, bytes: Uint8Array) { await this.bucket.put(this.check(key), bytes); }
  async get(key: string) { const o = await this.bucket.get(this.check(key)); return o ? new Uint8Array(await o.arrayBuffer()) : null; }
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type AllowedMime = (typeof ALLOWED)[number];

/** Detecta o tipo pelos magic bytes (nunca confia no Content-Type nem no nome do arquivo). */
export function sniffMime(b: Uint8Array): AllowedMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  if (b.length >= 5 && String.fromCharCode(...b.slice(0, 5)) === "%PDF-") return "application/pdf";
  return null;
}

/** Valida tamanho, tipo declarado e magic bytes coerentes. Retorna o MIME real. */
export function validateUpload(bytes: Uint8Array, declared: string | undefined): AllowedMime {
  if (bytes.length === 0) throw new HttpError(422, "empty_file");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(422, "file_too_large");
  const real = sniffMime(bytes);
  if (!real) throw new HttpError(422, "unsupported_file_type");
  if (declared && declared.split(";")[0]!.trim().toLowerCase() !== real) throw new HttpError(422, "mime_mismatch");
  return real;
}

const te = new TextEncoder();

async function hmacHex(secret: Uint8Array, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(msg)));
  return Array.from(sig, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** URL assinada de curta duração. A chave de assinatura é derivada da chave de criptografia (domínio separado). */
export async function signFileUrl(secret: Uint8Array, tenantId: string, attachmentId: string, ttlSeconds: number, now = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = await hmacHex(secret, `file:${tenantId}:${attachmentId}:${exp}`);
  return `/files/${tenantId}/${attachmentId}?exp=${exp}&sig=${sig}`;
}

export async function verifyFileSig(secret: Uint8Array, tenantId: string, attachmentId: string, exp: string, sig: string, now = Date.now()): Promise<boolean> {
  const e = Number(exp);
  if (!Number.isInteger(e) || e < Math.floor(now / 1000)) return false;
  const expected = await hmacHex(secret, `file:${tenantId}:${attachmentId}:${e}`);
  return constantTimeEqual(te.encode(expected), te.encode(sig));
}
void sha256Hex;
