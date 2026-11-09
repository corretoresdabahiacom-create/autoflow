import { HttpError } from "./http";

export interface EmailMessage {
  to: string;
  template: "invite" | "password_reset";
  /** Variáveis do template. Contêm tokens: nunca registrar em log. */
  vars: Record<string, string>;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

/** Provedor de e-mail ainda não escolhido (ver KNOWN_ISSUES KI-010): falha de forma explícita. */
export class UnconfiguredEmailProvider implements EmailProvider {
  async send(): Promise<void> {
    throw new HttpError(503, "email_provider_not_configured");
  }
}

/** Para desenvolvimento e testes: guarda mensagens em memória. */
export class MemoryEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}
