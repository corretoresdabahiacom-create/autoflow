export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

/** Cliente HTTP: cookies de sessão (HttpOnly) vão automaticamente; nada é guardado em localStorage. */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "offline");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? "error");
  return json as T;
}

export const ERRORS: Record<string, string> = {
  offline: "Sem conexão. Verifique a internet e tente de novo.",
  invalid_credentials: "E-mail, senha ou oficina incorretos.",
  account_locked: "Conta bloqueada temporariamente por tentativas falhas.",
  mfa_required: "Informe o código do autenticador.",
  rate_limited: "Muitas tentativas. Aguarde um pouco.",
  plate_exists: "Já existe veículo com esta placa.",
  permission_denied: "Você não tem permissão para isso.",
  not_approved: "Item não aprovado: não pode ser executado.",
  limit_reached: "Limite do plano atingido.",
  invalid_link: "Link inválido. Peça um novo à oficina.",
  link_revoked: "Este link foi cancelado. Peça um novo à oficina.",
  link_expired: "Este link expirou. Peça um novo à oficina.",
  session_expired: "Sua sessão expirou. Abra o link novamente.",
  invalid_otp: "Código incorreto ou expirado.",
  version_obsolete: "O orçamento foi atualizado. Recarregue a página.",
  otp_channel_not_configured: "Envio de código indisponível. Fale com a oficina.",
  justification_required: "Informe o motivo da recusa.",
  validation_error: "Confira os campos informados.",
};
export const errText = (e: unknown) => (e instanceof ApiError ? (ERRORS[e.code] ?? `Erro (${e.code})`) : "Erro inesperado.");
