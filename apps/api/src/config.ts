import { fromB64 } from "./crypto";

export interface Config {
  env: "development" | "test" | "production";
  databaseUrl: string;
  encryptionKey: Uint8Array;
  ipHashSalt: string;
  allowedOrigins: string[];
  scryptLogN: number;
  cookieSecure: boolean;
  /** Só fora de produção: devolve tokens de convite/reset na resposta (não há provedor de e-mail ainda). */
  exposeDevTokens: boolean;
  tenantSessionIdleMinutes: number;
  tenantSessionAbsoluteHours: number;
  platformSessionIdleMinutes: number;
  platformSessionAbsoluteHours: number;
  platformMfaRecentMinutes: number;
  portalSessionIdleMinutes: number;
  portalSessionAbsoluteHours: number;
  portalFailDelayBaseMs: number;
  portalBaseUrl: string;
  publicBaseUrl: string;
  turnstileSiteKey: string | null;
  metaAppSecret: string | null;
  waVerifyToken: string | null;
  metaGraphVersion: string;
  sandboxWebhookSecret: string | null;
  vapidPublicKey: string | null;
  logLevel: "silent" | "info";
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Configuração ausente: ${name}`);
  return v;
}

/** Falha fechada: em produção não há valores padrão para segredos. */
export function loadConfig(env: Env = process.env): Config {
  const mode = (env.NODE_ENV ?? "development") as Config["env"];
  if (!["development", "test", "production"].includes(mode)) throw new Error("NODE_ENV inválido");
  const prod = mode === "production";

  const keyB64 = prod ? required(env, "APP_ENCRYPTION_KEY") : (env.APP_ENCRYPTION_KEY ?? "");
  let encryptionKey: Uint8Array;
  if (keyB64) {
    encryptionKey = fromB64(keyB64);
  } else {
    // desenvolvimento/teste: chave efêmera por processo (segredos cifrados não sobrevivem a restart)
    encryptionKey = crypto.getRandomValues(new Uint8Array(32));
  }
  if (encryptionKey.length !== 32) throw new Error("APP_ENCRYPTION_KEY deve decodificar para 32 bytes");

  const logN = Number(env.PASSWORD_SCRYPT_LOG_N ?? (prod ? "" : "15"));
  if (!Number.isInteger(logN) || logN < 10 || logN > 20) throw new Error("PASSWORD_SCRYPT_LOG_N inválido (10–20)");
  if (prod && logN < 15) throw new Error("PASSWORD_SCRYPT_LOG_N < 15 não é permitido em produção");

  const origins = (prod ? required(env, "ALLOWED_ORIGINS") : (env.ALLOWED_ORIGINS ?? "http://localhost:5173"))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (prod && origins.some((o) => !o.startsWith("https://"))) throw new Error("ALLOWED_ORIGINS deve usar https em produção");

  return {
    env: mode,
    databaseUrl: required(env, "DATABASE_URL"),
    encryptionKey,
    ipHashSalt: prod ? required(env, "IP_HASH_SALT") : (env.IP_HASH_SALT ?? "dev-salt"),
    allowedOrigins: origins,
    scryptLogN: logN,
    cookieSecure: prod,
    exposeDevTokens: !prod && env.EXPOSE_DEV_TOKENS !== "false",
    tenantSessionIdleMinutes: 60,
    tenantSessionAbsoluteHours: 12,
    platformSessionIdleMinutes: 30,
    platformSessionAbsoluteHours: 8,
    platformMfaRecentMinutes: 15,
    portalSessionIdleMinutes: 30,
    portalSessionAbsoluteHours: 4,
    portalFailDelayBaseMs: Number(env.PORTAL_FAIL_DELAY_MS ?? 250),
    portalBaseUrl: env.PORTAL_BASE_URL ?? origins[0] ?? "http://localhost:5173",
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "http://localhost:8787").replace(/\/$/, ""),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
    metaAppSecret: env.META_APP_SECRET ?? null,
    waVerifyToken: env.WA_VERIFY_TOKEN ?? null,
    metaGraphVersion: env.META_GRAPH_VERSION ?? "v21.0",
    sandboxWebhookSecret: prod ? (env.SANDBOX_WEBHOOK_SECRET ?? null) : (env.SANDBOX_WEBHOOK_SECRET ?? "sandbox-secret"),
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
    logLevel: mode === "test" ? "silent" : "info",
  };
}
