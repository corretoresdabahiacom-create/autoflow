import { Hono } from "hono";
import { routePath } from "hono/route";
import { ZodError } from "zod";
import { hashIp } from "./crypto";
import { HttpError, clientIp } from "./http";
import { Router } from "./router";
import { registerAuthRoutes } from "./routes/auth";
import { registerPlatformRoutes } from "./routes/platform";
import { registerTenantRoutes } from "./routes/tenant";
import { registerCustomerRoutes } from "./routes/customers";
import { registerOrderRoutes } from "./routes/orders";
import { registerEstimateRoutes } from "./routes/estimates";
import { registerPortalRoutes } from "./routes/portal";
import { registerPortalAdminRoutes } from "./routes/portal-admin";
import { registerProductionRoutes } from "./routes/production";
import { registerFinanceRoutes } from "./routes/finance";
import { registerSitePublicRoutes } from "./routes/site-public";
import { registerSiteAdminRoutes } from "./routes/site-admin";
import { Metrics } from "./metrics";
import { registerLgpdRoutes } from "./routes/lgpd";
import { registerAdvancedRoutes } from "./routes/advanced";
import { registerBillingRoutes } from "./routes/billing";
import { registerIntegrationRoutes } from "./routes/integrations";
import { registerCrmRoutes } from "./routes/crm";
import { registerStockRoutes } from "./routes/stock";
import type { AppEnv, Deps } from "./types";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  const metrics = new Metrics();

  app.use("*", async (c, next) => {
    const t0 = performance.now();
    c.set("requestId", crypto.randomUUID());
    c.set("ipHash", await hashIp(clientIp(c), deps.config.ipHashSalt));
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
    c.header("X-Request-Id", c.get("requestId"));
    // Cabeçalhos de defesa em profundidade (páginas SSR definem a própria CSP; JSON recebe CSP restritiva).
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (deps.config.env === "production") c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    // Métricas e log de acesso: rota por PADRÃO (sem ids/tokens), sem corpo, sem headers, sem IP em claro.
    const ms = performance.now() - t0; const rp = routePath(c, -1); const route = rp === "/*" || rp === "*" ? "(unmatched)" : rp;
    metrics.record(c.req.method, route, c.res.status, ms / 1000);
    if (deps.config.logLevel !== "silent" && route !== "/health") console.log(JSON.stringify({ level: "info", msg: "req", requestId: c.get("requestId"), method: c.req.method, route, status: c.res.status, ms: Math.round(ms), tenantId: c.get("tenant")?.tenantId }));
  });

  // CSRF: métodos mutáveis exigem Origin explicitamente permitida (cookies são SameSite=Lax).
  app.use("*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !c.req.path.startsWith("/webhooks/")) { // /webhooks/*: sem cookies; autenticidade = assinatura do corpo
      const origin = c.req.header("origin");
      const publicOrigin = ((c.req.path.startsWith("/o/") && c.req.path.endsWith("/lead")) || c.req.path.startsWith("/optout/")) && origin === new URL(deps.config.publicBaseUrl).origin;
      if (!origin || (!deps.config.allowedOrigins.includes(origin) && !publicOrigin)) {
        throw new HttpError(403, "origin_not_allowed");
      }
    }
    await next();
  });

  const router = new Router(app, deps);
  router.get("/health", { auth: "public" }, (c) => c.json({ ok: true }));
  // Prontidão: o processo está de pé E consegue falar com o banco (usado pelo balanceador/deploy e pelo smoke test).
  router.get("/ready", { auth: "public" }, async (c) => {
    try { await deps.db.tx({ actor: "platform" }, (q) => q.query("select 1")); return c.json({ ok: true, db: "up" }); } catch { return c.json({ ok: false, db: "down" }, 503); }
  });
  // Métricas Prometheus (token Bearer; sem token configurado = 404). Gauges operacionais são só contagens.
  router.get("/metrics", { auth: "public" }, async (c) => {
    const tok = deps.config.metricsToken; const got = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
    if (!tok) return c.json({ error: "not_found" }, 404);
    const a = new TextEncoder().encode(got.padEnd(tok.length)), b = new TextEncoder().encode(tok); let diff = got.length ^ tok.length; for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i]!;
    if (diff !== 0) return c.json({ error: "unauthorized" }, 401);
    const g: Record<string, number> = { autoflow_db_pool_total: deps.db.pool.totalCount, autoflow_db_pool_idle: deps.db.pool.idleCount, autoflow_db_pool_waiting: deps.db.pool.waitingCount };
    try {
      const o = await deps.db.tx({ actor: "platform" }, async (q) => ({
        outbox: await q.one<{ pending: string; failed: string; oldest: string | null }>("select count(*) filter (where status = 'pending')::bigint pending, count(*) filter (where status = 'failed')::bigint failed, extract(epoch from now() - min(available_at) filter (where status = 'pending'))::bigint oldest from outbox"),
        hooks: await q.one<{ dead: string; failed: string }>("select count(*) filter (where status = 'dead')::bigint dead, count(*) filter (where status = 'failed')::bigint failed from webhook_events"),
        subs: await q.one<{ past_due: string; suspended: string }>("select count(*) filter (where status = 'past_due')::bigint past_due, count(*) filter (where status = 'suspended')::bigint suspended from subscriptions"),
      }));
      g.autoflow_outbox_pending = Number(o.outbox?.pending ?? 0); g.autoflow_outbox_failed = Number(o.outbox?.failed ?? 0); g.autoflow_outbox_oldest_pending_seconds = Math.max(0, Number(o.outbox?.oldest ?? 0));
      g.autoflow_webhook_dead = Number(o.hooks?.dead ?? 0); g.autoflow_webhook_failed = Number(o.hooks?.failed ?? 0);
      g.autoflow_subscriptions_past_due = Number(o.subs?.past_due ?? 0); g.autoflow_subscriptions_suspended = Number(o.subs?.suspended ?? 0); g.autoflow_db_up = 1;
    } catch { g.autoflow_db_up = 0; }
    return new Response(metrics.render(g), { headers: { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store" } });
  });
  registerAuthRoutes(router, deps);
  registerTenantRoutes(router, deps);
  registerPlatformRoutes(router, deps);
  registerCustomerRoutes(router, deps);
  registerOrderRoutes(router, deps);
  registerEstimateRoutes(router, deps);
  registerPortalRoutes(router, deps);
  registerPortalAdminRoutes(router, deps);
  registerProductionRoutes(router, deps);
  registerFinanceRoutes(router, deps);
  registerSitePublicRoutes(router, deps);
  registerSiteAdminRoutes(router, deps);
  registerStockRoutes(router, deps);
  registerCrmRoutes(router, deps);
  registerIntegrationRoutes(router, deps);
  registerBillingRoutes(router, deps);
  registerAdvancedRoutes(router, deps);
  registerLgpdRoutes(router, deps);

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
      return c.json({ error: err.code, ...(err.message !== err.code ? { message: err.message } : {}) }, err.status);
    }
    if (err instanceof ZodError) return c.json({ error: "validation_error" }, 422);
    const pgCode = (err as { code?: string }).code;
    if (pgCode === "23514") return c.json({ error: "constraint_violation", message: (err as Error).message }, 409);
    if (pgCode === "23P01") return c.json({ error: "box_conflict" }, 409);
    if (pgCode === "23505") return c.json({ error: "conflict" }, 409);
    if (pgCode === "23503") return c.json({ error: "invalid_reference" }, 422);
    if (deps.config.logLevel !== "silent") {
      // Nunca registrar corpo/headers/tokens: apenas tipo do erro e id da requisição.
      console.error(JSON.stringify({ level: "error", requestId: c.get("requestId"), name: (err as Error).name }));
    }
    return c.json({ error: "internal_error" }, 500);
  });

  return { app, registry: router.registry, metrics };
}
