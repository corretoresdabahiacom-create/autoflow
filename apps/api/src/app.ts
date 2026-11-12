import { Hono } from "hono";
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
import { registerCrmRoutes } from "./routes/crm";
import { registerStockRoutes } from "./routes/stock";
import type { AppEnv, Deps } from "./types";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.set("ipHash", await hashIp(clientIp(c), deps.config.ipHashSalt));
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
    c.header("X-Request-Id", c.get("requestId"));
  });

  // CSRF: métodos mutáveis exigem Origin explicitamente permitida (cookies são SameSite=Lax).
  app.use("*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
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

  return { app, registry: router.registry };
}
