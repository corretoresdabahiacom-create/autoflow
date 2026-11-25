import { createApp } from "./app";
import { loadConfig } from "./config";
import { Db } from "./db";
import { MemoryCaptcha, TurnstileCaptcha, UnconfiguredCaptcha } from "./captcha";
import { UnconfiguredEmailProvider } from "./email";
import { MemoryOtpChannel, UnconfiguredOtpChannel } from "./otp";
import { CloudApiWhatsApp, MemoryPush, SandboxPayments, SandboxWhatsApp, UnconfiguredPayments, UnconfiguredPush } from "./providers";
import { MemoryStorage, R2Storage, UnconfiguredStorage, type R2BucketLike } from "./storage";
import { MemoryEmailProvider } from "./email";
import { runJob, type JobName } from "./scheduler";
import type { Deps } from "./types";

/** Bindings esperados (ver wrangler.jsonc). Segredos/variáveis de texto chegam como string; o resto são bindings. */
export interface WorkerEnv {
  HYPERDRIVE: { connectionString: string };
  FILES?: R2BucketLike;
  ASSETS: { fetch(req: Request): Promise<Response> };
  [k: string]: unknown;
}

/** Quais jobs cada Cron Trigger dispara (strings devem coincidir com `triggers.crons` do wrangler.jsonc). */
export const CRON_JOBS: Record<string, JobName[]> = {
  "* * * * *": ["outbox", "webhooks"],
  "*/5 * * * *": ["automation"],
  "0 * * * *": ["billing"],
};

let cache: { key: string; deps: Deps; app: (req: Request) => Response | Promise<Response> } | null = null;

function build(env: WorkerEnv) {
  const key = env.HYPERDRIVE.connectionString;
  if (cache && cache.key === key) return cache;
  const strings: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") strings[k] = v;
  const config = loadConfig({ ...strings, NODE_ENV: strings.NODE_ENV ?? "production", DATABASE_URL: key });
  const prod = config.env === "production";
  // Sem pool entre requisições: o Hyperdrive faz o pooling (ver Db.perTx).
  const db = new Db(config.databaseUrl, 1, { perTx: true });
  const deps: Deps = {
    config, db,
    email: prod ? new UnconfiguredEmailProvider() : new MemoryEmailProvider(), // KI-010
    storage: env.FILES ? new R2Storage(env.FILES) : prod ? new UnconfiguredStorage() : new MemoryStorage(),
    otp: prod ? new UnconfiguredOtpChannel() : new MemoryOtpChannel(), // KI-003
    captcha: !prod ? new MemoryCaptcha() : strings.TURNSTILE_SECRET ? new TurnstileCaptcha(strings.TURNSTILE_SECRET) : new UnconfiguredCaptcha(),
    whatsapp: prod ? new CloudApiWhatsApp(config.metaGraphVersion) : new SandboxWhatsApp(), // KI-061
    payments: prod ? new UnconfiguredPayments() : new SandboxPayments(config), // KI-062
    push: prod ? new UnconfiguredPush() : new MemoryPush(),
  };
  const { app } = createApp(deps);
  cache = { key, deps, app: (req) => app.fetch(req) };
  return cache;
}

/** Caminhos atendidos pela API na raiz (SSR público, arquivos assinados, webhooks, saúde). Demais vão para o front (assets/SPA). */
export const API_ROOT_PREFIXES = ["/o/", "/c/", "/m/", "/files/", "/webhooks/", "/robots.txt", "/sitemap", "/health", "/ready", "/metrics"];

export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        url.pathname = url.pathname.replace(/^\/api/, "") || "/";
        return await build(env).app(new Request(url, req));
      }
      if (API_ROOT_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p))) return await build(env).app(req);
      return await env.ASSETS.fetch(req);
    } catch (e) {
      // Falha de configuração/boot (ex.: segredo ausente): resposta genérica, detalhe só no log do Worker.
      console.error(JSON.stringify({ level: "error", msg: "worker_fetch_failed", error: e instanceof Error ? e.message.slice(0, 200) : "error" }));
      return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "content-type": "application/json" } });
    }
  },
  async scheduled(ev: { cron: string }, env: WorkerEnv, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const jobs = CRON_JOBS[ev.cron]; if (!jobs) return;
    const { deps } = build(env);
    ctx.waitUntil((async () => { for (const j of jobs) await runJob(deps, j); })());
  },
};
