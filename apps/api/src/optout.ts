import { constantTimeEqual } from "./crypto";

const te = new TextEncoder();
async function hmac(secret: Uint8Array, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(`optout:${msg}`))), (x) => x.toString(16).padStart(2, "0")).join("");
}
/** Link de opt-out sem login: assinado (HMAC, domínio separado), sem expiração (o cliente pode sair a qualquer momento). */
export async function optOutPath(secret: Uint8Array, tenantId: string, customerId: string): Promise<string> {
  return `/optout/${tenantId}/${customerId}?sig=${await hmac(secret, `${tenantId}:${customerId}`)}`;
}
export async function verifyOptOut(secret: Uint8Array, tenantId: string, customerId: string, sig: string): Promise<boolean> {
  return constantTimeEqual(te.encode(await hmac(secret, `${tenantId}:${customerId}`)), te.encode(sig));
}
