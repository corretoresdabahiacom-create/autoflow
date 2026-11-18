// Regras puras da Fase 9 (seguradoras, comissões, agenda, automações). Sem I/O.

// ===== Seguradoras =====
export const CLAIM_STATES = ["opened", "awaiting_authorization", "authorized", "partially_authorized", "denied", "completed", "paid", "cancelled"] as const;
export type ClaimStatus = (typeof CLAIM_STATES)[number];
const CLAIM_NEXT: Record<ClaimStatus, ClaimStatus[]> = {
  opened: ["awaiting_authorization", "cancelled"],
  awaiting_authorization: ["authorized", "partially_authorized", "denied", "cancelled"],
  authorized: ["awaiting_authorization", "completed", "cancelled"], // nova rodada (ex.: complemento/supervalor)
  partially_authorized: ["awaiting_authorization", "completed", "cancelled"],
  denied: ["awaiting_authorization", "cancelled"], // recurso/reanálise
  completed: ["paid"],
  paid: [],
  cancelled: [],
};
export function claimCanMove(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM_NEXT[from]?.includes(to) ?? false;
}
export function claimIsClosed(s: ClaimStatus): boolean { return s === "paid" || s === "cancelled"; }

/** Prazo de autorização = momento do pedido + SLA da seguradora (horas corridas; calendário de dias úteis não modelado — KI). */
export function authorizationDue(requestedAtMs: number, slaHours: number): number {
  if (!Number.isInteger(slaHours) || slaHours < 1) throw new Error("sla inválido");
  return requestedAtMs + slaHours * 3600_000;
}
export type ClaimDeadline = "none" | "ok" | "due_soon" | "overdue";
export function claimDeadline(status: ClaimStatus, dueMs: number | null, nowMs: number, soonHours = 12): ClaimDeadline {
  if (status !== "awaiting_authorization" || dueMs == null) return "none";
  if (nowMs > dueMs) return "overdue";
  return dueMs - nowMs <= soonHours * 3600_000 ? "due_soon" : "ok";
}
export type AuthDecision = "authorized" | "partial" | "denied";
/** Decisão derivada dos valores (não aceita rótulo inconsistente com o valor). */
export function decideAuthorization(requestedCents: number, authorizedCents: number): AuthDecision {
  if (!Number.isInteger(requestedCents) || !Number.isInteger(authorizedCents) || requestedCents < 0 || authorizedCents < 0) throw new Error("valores inválidos");
  if (authorizedCents > requestedCents) throw new Error("autorizado maior que solicitado");
  if (authorizedCents === 0) return "denied";
  return authorizedCents === requestedCents ? "authorized" : "partial";
}
/** Franquia: parte do cliente; seguradora cobre o restante autorizado. */
export function insurerShare(authorizedCents: number, deductibleCents: number): { insurerCents: number; customerCents: number } {
  const customer = Math.min(deductibleCents, authorizedCents);
  return { insurerCents: authorizedCents - customer, customerCents: customer };
}

// ===== Comissões =====
export interface RuleVersion { id: string; versionNo: number; validFromMs: number; basis: "os_net_revenue" | "os_margin"; rateBps: number }
/** Regra vigente na data de referência (a da entrega da OS): maior valid_from <= ref; empate => maior versão. Histórico nunca é reescrito. */
export function pickRule<T extends { validFromMs: number; versionNo: number }>(rules: readonly T[], refMs: number): T | null {
  let best: T | null = null;
  for (const r of rules) {
    if (r.validFromMs > refMs) continue;
    if (!best || r.validFromMs > best.validFromMs || (r.validFromMs === best.validFromMs && r.versionNo > best.versionNo)) best = r;
  }
  return best;
}
/** Percentual em pontos-base (1% = 100), arredondamento meio-para-cima, base não negativa. */
export function commissionAmount(basisCents: number, rateBps: number): number {
  if (!Number.isInteger(basisCents) || !Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) throw new Error("parâmetros inválidos");
  if (basisCents <= 0) return 0;
  return Math.floor((basisCents * rateBps + 5000) / 10000);
}
/** Diferença entre o devido hoje e o já lançado (lançamento de ajuste; nunca edita o anterior). */
export function commissionAdjustment(accruedSoFarCents: number, dueNowCents: number): number { return dueNowCents - accruedSoFarCents; }
/** Pagamento: abate adiantamentos em aberto do valor bruto devido. */
export function payoutSplit(grossCents: number, outstandingAdvancesCents: number): { offsetCents: number; netCents: number } {
  if (grossCents <= 0) throw new Error("bruto deve ser positivo");
  const offset = Math.min(Math.max(outstandingAdvancesCents, 0), grossCents);
  return { offsetCents: offset, netCents: grossCents - offset };
}

// ===== Agenda avançada =====
export interface Interval { startMs: number; endMs: number }
export const overlaps = (a: Interval, b: Interval) => a.startMs < b.endMs && b.startMs < a.endMs;
/** Primeiro horário livre (grade de `stepMin`) dentro da janela para a duração pedida; null se não houver. */
export function findFreeSlot(busy: readonly Interval[], window: Interval, durationMin: number, stepMin = 15): number | null {
  const dur = durationMin * 60_000; const step = stepMin * 60_000;
  for (let s = Math.ceil(window.startMs / step) * step; s + dur <= window.endMs; s += step) {
    if (!busy.some((b) => overlaps({ startMs: s, endMs: s + dur }, b))) return s;
  }
  return null;
}
/** A entrada da fila cabe no horário liberado? (duração e janela desejada). */
export function waitlistFits(e: { windowFromMs: number; windowToMs: number; durationMin: number }, slot: Interval): boolean {
  return slot.startMs >= e.windowFromMs && slot.endMs <= e.windowToMs && slot.endMs - slot.startMs >= e.durationMin * 60_000;
}

// ===== Automações =====
export const AUTOMATION_VARS = ["customer_first_name", "os_number", "plate"] as const;
/** Substitui {{var}} apenas por variáveis permitidas; desconhecida => erro (não vaza dado arbitrário). */
export function renderParam(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, k: string) => {
    if (!(AUTOMATION_VARS as readonly string[]).includes(k)) throw new Error(`variável não permitida: ${k}`);
    return vars[k] ?? "";
  });
}
export type AutomationGate = { ok: true } | { ok: false; reason: "platform_kill_switch" | "tenant_disabled" | "limit_reached" };
export function automationGate(a: { platformKill: boolean; tenantEnabled: boolean; usedThisMonth: number; limit: number | null }): AutomationGate {
  if (a.platformKill) return { ok: false, reason: "platform_kill_switch" };
  if (!a.tenantEnabled) return { ok: false, reason: "tenant_disabled" };
  if (a.limit !== null && a.usedThisMonth >= a.limit) return { ok: false, reason: "limit_reached" };
  return { ok: true };
}
