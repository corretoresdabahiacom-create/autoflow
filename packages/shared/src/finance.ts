/** Regras financeiras puras. Valores em centavos (inteiros). Arredondamento HALF_EVEN. */

export function divRoundHalfEven(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error("den inválido");
  const neg = num < 0n; const n = neg ? -num : num;
  let q = n / den; const r2 = (n % den) * 2n;
  if (r2 > den || (r2 === den && q % 2n === 1n)) q += 1n;
  return neg ? -q : q;
}

/** Divide `total` em `n` parcelas; o resto (centavos) vai para a ÚLTIMA parcela. Σ = total sempre. */
export function splitCents(total: number, n: number): number[] {
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(n) || n < 1) throw new Error("splitCents: entrada inválida");
  const base = Math.floor(total / n);
  const out = Array<number>(n).fill(base);
  out[n - 1] = total - base * (n - 1);
  return out;
}

/** Rateio proporcional a pesos pelo método do maior resto: Σ = total, sem perda de centavos. */
export function allocateProRata(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!Number.isInteger(total) || total < 0 || weights.length === 0 || sum <= 0 || weights.some((w) => w < 0 || !Number.isInteger(w))) throw new Error("allocateProRata: entrada inválida");
  const raw = weights.map((w) => (BigInt(total) * BigInt(w)));
  const S = BigInt(sum);
  const base = raw.map((r) => r / S);
  let left = total - base.reduce((s, b) => s + Number(b), 0);
  const order = raw.map((r, i) => ({ i, rem: r % S })).sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  const out = base.map(Number);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length]!.i]! += 1;
  return out;
}

export interface LateInput { principalCents: number; dueDate: string; on: string; fineBp: number; interestBpMonth: number }
const dayNum = (d: string) => Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000);
export const daysLate = (dueDate: string, on: string) => Math.max(0, dayNum(on) - dayNum(dueDate));

/** Multa única (% sobre o principal) + juros simples pro rata die (% ao mês, mês=30 dias) quando em atraso. Regra versionada: v1. */
export function lateCharges(i: LateInput): { days: number; fineCents: number; interestCents: number; ruleVersion: "v1" } {
  const days = daysLate(i.dueDate, i.on);
  if (days === 0) return { days, fineCents: 0, interestCents: 0, ruleVersion: "v1" };
  const P = BigInt(i.principalCents);
  const fine = divRoundHalfEven(P * BigInt(i.fineBp), 10_000n);
  const interest = divRoundHalfEven(P * BigInt(i.interestBpMonth) * BigInt(days), 10_000n * 30n);
  return { days, fineCents: Number(fine), interestCents: Number(interest), ruleVersion: "v1" };
}

export type InstallmentStatus = "open" | "partial" | "paid" | "overdue" | "cancelled";
/** Status derivado (nunca armazenado). */
export function installmentStatus(i: { amountCents: number; paidCents: number; dueDate: string; today: string; cancelled: boolean }): InstallmentStatus {
  if (i.cancelled) return "cancelled";
  if (i.paidCents >= i.amountCents) return "paid";
  if (daysLate(i.dueDate, i.today) > 0) return "overdue";
  return i.paidCents > 0 ? "partial" : "open";
}

/** Alçada: desconto acima do limite (em bp do bruto) exige permissão de exceção. */
export const discountNeedsOverride = (grossCents: number, discountCents: number, limitBp: number) =>
  BigInt(discountCents) * 10_000n > BigInt(grossCents) * BigInt(limitBp);

export interface DreInput { revenue: number; deductions: number; directCosts: number; opex: number; financial: number }
/** DRE gerencial (rótulo obrigatório: "gerencial estimado"). */
export function buildDre(i: DreInput) {
  const netRevenue = i.revenue - i.deductions;
  const contributionMargin = netRevenue - i.directCosts;
  const operatingResult = contributionMargin - i.opex;
  return { grossRevenue: i.revenue, deductions: i.deductions, netRevenue, directCosts: i.directCosts, contributionMargin, opex: i.opex, operatingResult, financialResult: i.financial, managementResult: operatingResult + i.financial, label: "gerencial estimado" as const };
}

/** Rateio de despesas fixas por OS. method: revenue (bp da receita líquida), hours (centavos por hora), fixed (centavos por OS). */
export function overheadForOrder(m: { method: "revenue" | "hours" | "fixed"; value: number }, o: { netRevenueCents: number; trackedMinutes: number }): number {
  if (m.method === "fixed") return m.value;
  if (m.method === "hours") return Number(divRoundHalfEven(BigInt(m.value) * BigInt(o.trackedMinutes), 60n));
  return Number(divRoundHalfEven(BigInt(o.netRevenueCents) * BigInt(m.value), 10_000n));
}
