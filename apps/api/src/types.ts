import type { Entitlements } from "@autoflow/shared";
import type { Config } from "./config";
import type { CaptchaVerifier } from "./captcha";
import type { Db } from "./db";
import type { EmailProvider } from "./email";
import type { OtpChannel } from "./otp";
import type { StorageProvider } from "./storage";

export interface Deps {
  config: Config;
  db: Db;
  email: EmailProvider;
  storage: StorageProvider;
  otp: OtpChannel;
  captcha: CaptchaVerifier;
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

export interface PortalPrincipal {
  sessionId: string;
  linkId: string;
  tenantId: string;
  unitId: string;
  osId: string;
}

export type AppEnv = {
  Variables: {
    portal: PortalPrincipal;
    requestId: string;
    ipHash: string;
    tenant: TenantPrincipal;
    platform: PlatformPrincipal;
    session: SessionRow;
  };
};
