import type { Entitlements } from "@autoflow/shared";
import type { Config } from "./config";
import type { Db } from "./db";
import type { EmailProvider } from "./email";

export interface Deps {
  config: Config;
  db: Db;
  email: EmailProvider;
}

export interface SessionRow {
  id: string;
  userId: string | null;
  platformUserId: string | null;
  tenantId: string | null;
  membershipId: string | null;
  mfaVerifiedAt: Date | null;
}

export interface TenantPrincipal {
  kind: "tenant";
  sessionId: string;
  userId: string;
  tenantId: string;
  membershipId: string;
  roleKey: string;
  permissions: Set<string>;
  unitScope: "all" | "list";
  unitIds: string[];
  entitlements: Entitlements;
}

export interface PlatformPrincipal {
  kind: "platform";
  sessionId: string;
  platformUserId: string;
  mfaVerifiedAt: Date | null;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    ipHash: string;
    tenant: TenantPrincipal;
    platform: PlatformPrincipal;
    session: SessionRow;
  };
};
