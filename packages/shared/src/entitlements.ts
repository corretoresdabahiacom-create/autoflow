export type FeatureValue = boolean | number | null; // null = ilimitado (para limites)

export type SubscriptionStatus = "trial" | "active" | "past_due" | "suspended" | "cancelled";

export interface Entitlements {
  readonly subscriptionStatus: SubscriptionStatus;
  readonly values: Readonly<Record<string, FeatureValue>>;
}

/** Plano é a base; override do tenant (definido pelo Super Admin, com motivo) prevalece. */
export function resolveEntitlements(
  planFeatures: Readonly<Record<string, FeatureValue>>,
  overrides: Readonly<Record<string, FeatureValue>>,
  subscriptionStatus: SubscriptionStatus,
): Entitlements {
  return { subscriptionStatus, values: { ...planFeatures, ...overrides } };
}

/** Assinatura suspensa/cancelada desliga tudo (sem apagar dados). */
export function subscriptionAllowsUse(status: SubscriptionStatus): boolean {
  return status !== "suspended" && status !== "cancelled";
}

export function hasFeature(e: Entitlements, code: string): boolean {
  if (!subscriptionAllowsUse(e.subscriptionStatus)) return false;
  return e.values[code] === true;
}

export type LimitCheck = { ok: true } | { ok: false; limit: number };

/** `current` = quantidade já usada; criar mais um exige current + 1 <= limite. */
export function checkLimit(e: Entitlements, code: string, current: number, adding = 1): LimitCheck {
  if (!subscriptionAllowsUse(e.subscriptionStatus)) return { ok: false, limit: 0 };
  const v = e.values[code];
  if (v === null) return { ok: true };
  if (typeof v !== "number") return { ok: false, limit: 0 }; // ausente/inválido => nega (falha fechada)
  return current + adding <= v ? { ok: true } : { ok: false, limit: v };
}
