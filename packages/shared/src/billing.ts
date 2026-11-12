/** Regras puras de billing de assinaturas (política de inadimplência e proração). Datas em ISO (UTC). */
export const GRACE_DAYS = 7;          // carência após o vencimento antes de suspender
export const INVOICE_LEAD_DAYS = 3;   // fatura de renovação é gerada N dias antes do fim do período
export const MAX_WEBHOOK_ATTEMPTS = 5;

export type SubStatus = "trial" | "active" | "past_due" | "suspended" | "cancelled";
const DAY = 86_400_000;

export function addMonths(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); return d.toISOString().slice(0, 10);
}
export const nextPeriodEnd = (end: string, interval: "month" | "year") => addMonths(end, interval === "year" ? 12 : 1);

/** Upgrade no meio do período: diferença de preço × fração restante do período (arredonda para centavo inteiro). */
export function prorateUpgrade(oldCents: number, newCents: number, periodStart: string, periodEnd: string, nowIso: string): number {
  const total = Math.max(1, (Date.parse(periodEnd) - Date.parse(periodStart)) / DAY);
  const left = Math.min(total, Math.max(0, (Date.parse(nowIso.slice(0, 10)) - 0 - (Date.parse(periodEnd) - 0)) / -DAY));
  const diff = newCents - oldCents; if (diff <= 0) return 0;
  return Math.round((diff * left) / total);
}

export interface DunningInput { status: SubStatus; oldestOpenDueMs: number | null; graceUntilMs: number | null; nowMs: number }
export type DunningAction = { action: "none" } | { action: "past_due"; graceUntilMs: number } | { action: "suspend" };
/** Fatura vencida => past_due com carência; carência esgotada => suspende (dados preservados). */
export function dunning(i: DunningInput): DunningAction {
  if (i.status === "suspended" || i.status === "cancelled") return { action: "none" };
  if (i.oldestOpenDueMs === null || i.oldestOpenDueMs > i.nowMs) return { action: "none" };
  const grace = i.graceUntilMs ?? i.oldestOpenDueMs + GRACE_DAYS * DAY;
  if (i.nowMs >= grace) return { action: "suspend" };
  return i.status === "past_due" && i.graceUntilMs ? { action: "none" } : { action: "past_due", graceUntilMs: grace };
}
export const backoffSeconds = (attempts: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
