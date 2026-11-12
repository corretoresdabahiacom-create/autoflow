/** Regras puras de estoque (custo médio móvel, ADR-0007) e fidelização. Quantidades em milésimos (1000 = 1 unidade); valores em centavos. */

export interface StockState { onHandMilli: number; valueCents: number }

const half = (num: bigint, den: bigint): bigint => (num * 2n + den) / (den * 2n); // arredonda metade para cima (valores >= 0)

/** Custo (centavos) de sair `qty` ao custo médio móvel atual. Saída total zera o valor (sem resíduo). */
export function outCost(s: StockState, qtyMilli: number): number {
  if (!Number.isInteger(qtyMilli) || qtyMilli <= 0) throw new Error("invalid_qty");
  if (qtyMilli > s.onHandMilli) throw new Error("insufficient_stock");
  if (qtyMilli === s.onHandMilli) return s.valueCents;
  return Number(half(BigInt(s.valueCents) * BigInt(qtyMilli), BigInt(s.onHandMilli)));
}
export function applyIn(s: StockState, qtyMilli: number, costCents: number): StockState {
  if (!Number.isInteger(qtyMilli) || qtyMilli <= 0 || !Number.isInteger(costCents) || costCents < 0) throw new Error("invalid_entry");
  return { onHandMilli: s.onHandMilli + qtyMilli, valueCents: s.valueCents + costCents };
}
export function applyOut(s: StockState, qtyMilli: number): { state: StockState; costCents: number } {
  const costCents = outCost(s, qtyMilli);
  return { state: { onHandMilli: s.onHandMilli - qtyMilli, valueCents: s.valueCents - costCents }, costCents };
}
/** Devolução ao estoque: volta pelo custo da saída original (proporcional à quantidade devolvida). */
export function returnCost(origQtyMilli: number, origCostCents: number, retQtyMilli: number): number {
  if (retQtyMilli <= 0 || retQtyMilli > origQtyMilli) throw new Error("invalid_return");
  if (retQtyMilli === origQtyMilli) return origCostCents;
  return Number(half(BigInt(origCostCents) * BigInt(retQtyMilli), BigInt(origQtyMilli)));
}
/** Custo médio por unidade inteira, em centavos (informativo). */
export const avgUnitCostCents = (s: StockState): number => (s.onHandMilli === 0 ? 0 : Number(half(BigInt(s.valueCents) * 1000n, BigInt(s.onHandMilli))));

export const parseQtyMilli = (v: number): number => {
  const m = Math.round(v * 1000);
  if (!Number.isFinite(v) || v <= 0 || Math.abs(m - v * 1000) > 1e-6) throw new Error("invalid_qty");
  return m;
};

/** Pontos de fidelidade: floor(R$ líquidos × pontos por real). */
export const loyaltyPoints = (netCents: number, pointsPerReal: number): number => Math.max(0, Math.floor((netCents / 100) * pointsPerReal));

export const REMINDER_KINDS = ["oil", "revision", "alignment", "other"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];
export const DEFAULT_REMINDER_DAYS: Record<ReminderKind, number> = { oil: 180, revision: 365, alignment: 180, other: 180 };
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}

/** Cupom: valor do desconto em centavos (nunca maior que o total). */
export function couponDiscount(kind: "percent" | "fixed", value: number, totalCents: number): number {
  const d = kind === "percent" ? Math.floor((totalCents * value) / 100) : value;
  return Math.max(0, Math.min(d, totalCents));
}
