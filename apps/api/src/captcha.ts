import { HttpError } from "./http";

export interface CaptchaVerifier { readonly name: string; verify(token: string | undefined, ip: string): Promise<boolean> }

/** Dev/teste: aceita apenas o token "ok-token". */
export class MemoryCaptcha implements CaptchaVerifier { readonly name = "memory"; async verify(t: string | undefined) { return t === "ok-token"; } }
/** Produção sem segredo: falha fechado (o formulário não cria leads sem anti-bot). */
export class UnconfiguredCaptcha implements CaptchaVerifier { readonly name = "unconfigured"; async verify(): Promise<boolean> { throw new HttpError(503, "captcha_not_configured"); } }
/** Cloudflare Turnstile (siteverify). NÃO validado contra o serviço real nesta fase. */
export class TurnstileCaptcha implements CaptchaVerifier {
  readonly name = "turnstile";
  constructor(private secret: string) {}
  async verify(token: string | undefined, ip: string): Promise<boolean> {
    if (!token) return false;
    try {
      const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: new URLSearchParams({ secret: this.secret, response: token, remoteip: ip }), signal: AbortSignal.timeout(5000) });
      return ((await r.json()) as { success?: boolean }).success === true;
    } catch { return false; }
  }
}
