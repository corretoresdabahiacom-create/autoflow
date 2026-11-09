import type { Context, Hono } from "hono";
import { HttpError } from "./http";
import { authenticatePlatform, authenticateTenant, sessionFromCookie } from "./principal";
import type { PlatformMfaLevel } from "./principal";
import { hasFeature } from "@autoflow/shared";
import type { AppEnv, Deps } from "./types";

/**
 * Toda rota DECLARA sua política de acesso. Rota fora deste roteador falha no teste de registro.
 */
export type Policy =
  | { auth: "public" }
  | { auth: "session" } // só identifica a sessão do tenant (ex.: logout)
  | { auth: "tenant"; permission: string | "any-member"; feature?: string; allowInactive?: boolean }
  | { auth: "platform"; mfa: PlatformMfaLevel };

export type Handler = (c: Context<AppEnv>) => Response | Promise<Response>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteDecl {
  method: Method;
  path: string;
  policy: Policy;
}

export class Router {
  readonly registry: RouteDecl[] = [];

  constructor(
    private readonly app: Hono<AppEnv>,
    private readonly deps: Deps,
  ) {}

  private add(method: Method, path: string, policy: Policy, handler: Handler): void {
    this.registry.push({ method, path, policy });
    this.app.on(method, path, async (c, next) => {
      await this.guard(c, policy);
      await next();
    }, handler);
  }

  get = (path: string, policy: Policy, h: Handler) => this.add("GET", path, policy, h);
  post = (path: string, policy: Policy, h: Handler) => this.add("POST", path, policy, h);
  put = (path: string, policy: Policy, h: Handler) => this.add("PUT", path, policy, h);
  patch = (path: string, policy: Policy, h: Handler) => this.add("PATCH", path, policy, h);
  delete = (path: string, policy: Policy, h: Handler) => this.add("DELETE", path, policy, h);

  private async guard(c: Context<AppEnv>, policy: Policy): Promise<void> {
    switch (policy.auth) {
      case "public":
        return;
      case "session":
        c.set("session", await sessionFromCookie(c, this.deps, "tenant"));
        return;
      case "tenant": {
        const p = await authenticateTenant(c, this.deps, { allowInactive: policy.allowInactive });
        if (policy.permission !== "any-member" && !p.permissions.has(policy.permission)) {
          throw new HttpError(403, "permission_denied");
        }
        if (policy.feature && !hasFeature(p.entitlements, policy.feature)) {
          throw new HttpError(403, "feature_not_in_plan");
        }
        c.set("tenant", p);
        return;
      }
      case "platform":
        c.set("platform", await authenticatePlatform(c, this.deps, policy.mfa));
        return;
    }
  }
}
