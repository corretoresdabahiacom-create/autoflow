import { HttpError } from "./http";
import { hmacSha256Hex, constantTimeEqual, randomToken } from "./crypto";
import type { Config } from "./config";

const te = new TextEncoder();
const safeEq = (a: string, b: string) => a.length === b.length && constantTimeEqual(te.encode(a), te.encode(b));

// ===== WhatsApp (ADR-0006) =====
export interface WaConnection { phoneNumberId: string; token: string }
export interface WaTemplateMessage { to: string; template: string; lang: string; params: string[] }
export interface WhatsAppProvider {
  readonly name: string;
  sendTemplate(conn: WaConnection, msg: WaTemplateMessage): Promise<{ providerMessageId: string }>;
}
/** Sandbox: NÃO envia nada, NÃO valida entrega real nem aprovação de template pela Meta. */
export class SandboxWhatsApp implements WhatsAppProvider {
  readonly name = "sandbox";
  readonly sent: { conn: WaConnection; msg: WaTemplateMessage }[] = [];
  failNext = false;
  async sendTemplate(conn: WaConnection, msg: WaTemplateMessage) {
    if (this.failNext) { this.failNext = false; throw new HttpError(502, "provider_error"); }
    this.sent.push({ conn, msg }); return { providerMessageId: `sbx.wamid.${randomToken(8)}` };
  }
}
/** WhatsApp Cloud API (Meta). NÃO VALIDADO contra a Meta (sem credenciais/app aprovado): bloqueado por dependência externa. */
export class CloudApiWhatsApp implements WhatsAppProvider {
  readonly name = "meta_cloud_api";
  constructor(private readonly graphVersion: string) {}
  async sendTemplate(conn: WaConnection, msg: WaTemplateMessage) {
    const r = await fetch(`https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(conn.phoneNumberId)}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ messaging_product: "whatsapp", to: msg.to.replace(/^\+/, ""), type: "template", template: { name: msg.template, language: { code: msg.lang }, components: msg.params.length ? [{ type: "body", parameters: msg.params.map((t) => ({ type: "text", text: t })) }] : [] } }),
    });
    if (!r.ok) throw new HttpError(502, "provider_error");
    const j = (await r.json()) as { messages?: { id: string }[] };
    const id = j.messages?.[0]?.id; if (!id) throw new HttpError(502, "provider_error");
    return { providerMessageId: id };
  }
}
/** Assinatura dos webhooks da Meta: `X-Hub-Signature-256: sha256=<hmac(app_secret, corpo bruto)>`. */
export async function verifyMetaSignature(appSecret: string | null, raw: string, header: string | null): Promise<boolean> {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  return safeEq(await hmacSha256Hex(appSecret, raw), header.slice(7));
}

// ===== Pagamentos / billing (ADR-0005) =====
export interface ChargeRequest { amountCents: number; method: "pix" | "boleto" | "card"; description: string; externalReference: string }
export interface PaymentProvider {
  readonly name: string;
  createCharge(apiKey: string, req: ChargeRequest): Promise<{ providerChargeId: string; checkoutUrl: string }>;
  verifyWebhook(raw: string, headers: (n: string) => string | undefined): Promise<boolean>;
}
/** Sandbox determinístico: não movimenta dinheiro real. Webhook assinado com HMAC (`x-sandbox-signature`). */
export class SandboxPayments implements PaymentProvider {
  readonly name = "sandbox";
  readonly created: ChargeRequest[] = [];
  constructor(private readonly cfg: Pick<Config, "sandboxWebhookSecret">) {}
  async createCharge(_k: string, req: ChargeRequest) { this.created.push(req); const id = `sbx_ch_${randomToken(8)}`; return { providerChargeId: id, checkoutUrl: `https://sandbox.invalid/pay/${id}` }; }
  async verifyWebhook(raw: string, h: (n: string) => string | undefined) {
    const sig = h("x-sandbox-signature"); const secret = this.cfg.sandboxWebhookSecret;
    return !!sig && !!secret && safeEq(await hmacSha256Hex(secret, raw), sig);
  }
}
/** Gateway real ainda não escolhido/credenciado (ADR-0005): falha explícita. */
export class UnconfiguredPayments implements PaymentProvider {
  readonly name = "unconfigured";
  async createCharge(): Promise<never> { throw new HttpError(503, "payments_not_configured"); }
  async verifyWebhook() { return false; }
}

// ===== Web Push (VAPID) =====
export interface PushSubscriptionRow { endpoint: string; p256dh: string; auth: string }
export interface PushProvider { readonly name: string; send(sub: PushSubscriptionRow, payload: { title: string; body: string }): Promise<void> }
export class MemoryPush implements PushProvider { readonly name = "memory"; readonly sent: { sub: PushSubscriptionRow; payload: { title: string; body: string } }[] = []; async send(sub: PushSubscriptionRow, payload: { title: string; body: string }) { this.sent.push({ sub, payload }); } }
/** Sem chaves VAPID/biblioteca de envio: bloqueado (KI). */
export class UnconfiguredPush implements PushProvider { readonly name = "unconfigured"; async send(): Promise<void> { throw new HttpError(503, "push_not_configured"); } }
