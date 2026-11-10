import { HttpError } from "./http";
import type { EmailProvider } from "./email";

export interface OtpTarget {
  phoneE164: string | null;
  email: string | null;
}

/** Canal de entrega do OTP. Retorna o destino mascarado (vai para a evidência, nunca o valor completo). */
export interface OtpChannel {
  readonly name: string;
  send(target: OtpTarget, code: string): Promise<string>;
}

export const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, "$1***$2");
export const maskPhone = (p: string) => `${p.slice(0, 5)}****${p.slice(-2)}`;

/** Sem canal real configurado (KI-003): falha explícita; o portal orienta a aprovar com o atendente. */
export class UnconfiguredOtpChannel implements OtpChannel {
  readonly name = "unconfigured";
  async send(): Promise<string> {
    throw new HttpError(503, "otp_channel_not_configured");
  }
}

/** Dev/teste: SIMULADO. Não envia nada e NÃO valida entrega real. */
export class MemoryOtpChannel implements OtpChannel {
  readonly name = "simulated";
  readonly sent: { target: OtpTarget; code: string }[] = [];
  async send(target: OtpTarget, code: string): Promise<string> {
    if (!target.phoneE164 && !target.email) throw new HttpError(409, "no_contact_for_otp");
    this.sent.push({ target, code });
    return target.phoneE164 ? maskPhone(target.phoneE164) : maskEmail(target.email!);
  }
}

/** E-mail como canal provisório (KI-003). Prova controle do e-mail, NÃO do telefone cadastrado. */
export class EmailOtpChannel implements OtpChannel {
  readonly name = "email";
  constructor(private readonly email: EmailProvider) {}
  async send(target: OtpTarget, code: string): Promise<string> {
    if (!target.email) throw new HttpError(409, "no_contact_for_otp");
    await this.email.send({ to: target.email, template: "otp", vars: { code } });
    return maskEmail(target.email);
  }
}
