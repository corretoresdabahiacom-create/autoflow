import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export type ItemCategory = "service" | "part" | "other";

export interface ItemContent {
  description: string;
  category: ItemCategory;
  qty: number; // até 3 casas
  unitPriceCents: number;
}

/** Placa normalizada (Mercosul ou antiga): 7 caracteres A–Z/0–9, sem hífen. */
export function normalizePlate(input: string): string | null {
  const p = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(p) ? p : null;
}

/** Telefone brasileiro → E.164. Aceita 10/11 dígitos (DDD+número) ou já com 55. */
export function normalizePhoneBR(input: string): string | null {
  const d = input.replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) return `+${d}`;
  return null;
}

const qtyMilli = (qty: number): bigint => BigInt(Math.round(qty * 1000));

/** Hash canônico do que o cliente aprova: descrição, categoria, quantidade e preço. */
export function itemHash(i: ItemContent): string {
  const canonical = JSON.stringify([
    i.description.trim().replace(/\s+/g, " "),
    i.category,
    qtyMilli(i.qty).toString(),
    String(i.unitPriceCents),
  ]);
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

/** Total da linha em centavos, em aritmética inteira (arredonda meio para cima). */
export function lineTotalCents(qty: number, unitPriceCents: number): number {
  const t = (qtyMilli(qty) * BigInt(unitPriceCents) + 500n) / 1000n;
  return Number(t);
}

export interface VersionItem extends ItemContent {
  lineKey: string;
  hash: string;
}

export type ItemChange = { field: "description" | "category" | "qty" | "unitPriceCents"; from: unknown; to: unknown };
export interface VersionDiff {
  added: VersionItem[];
  removed: VersionItem[];
  changed: { lineKey: string; changes: ItemChange[]; from: VersionItem; to: VersionItem }[];
  unchanged: string[];
}

/** Diferença entre duas versões, casando linhas por `lineKey`. */
export function diffVersions(from: readonly VersionItem[], to: readonly VersionItem[]): VersionDiff {
  const a = new Map(from.map((i) => [i.lineKey, i]));
  const b = new Map(to.map((i) => [i.lineKey, i]));
  const out: VersionDiff = { added: [], removed: [], changed: [], unchanged: [] };
  for (const [k, i] of b) {
    const prev = a.get(k);
    if (!prev) out.added.push(i);
    else if (prev.hash === i.hash) out.unchanged.push(k);
    else {
      const changes: ItemChange[] = [];
      for (const f of ["description", "category", "qty", "unitPriceCents"] as const) {
        if (prev[f] !== i[f]) changes.push({ field: f, from: prev[f], to: i[f] });
      }
      out.changed.push({ lineKey: k, changes, from: prev, to: i });
    }
  }
  for (const [k, i] of a) if (!b.has(k)) out.removed.push(i);
  return out;
}

/**
 * REGRA DE HERANÇA (documentada em docs/FINANCIAL_RULES.md / FASE-02): uma aprovação de versão
 * anterior vale para a versão atual SOMENTE se a linha (lineKey) existe e o hash do conteúdo é idêntico.
 * Recusas nunca são herdadas (o item volta a pendente). Qualquer mudança de qtd/preço/escopo exige nova aprovação.
 */
export function inheritsApproval(item: Pick<VersionItem, "lineKey" | "hash">, priorApproved: readonly Pick<VersionItem, "lineKey" | "hash">[]): boolean {
  return priorApproved.some((p) => p.lineKey === item.lineKey && p.hash === item.hash);
}

export type ItemStatus = "pending" | "approved" | "rejected" | "approved_inherited";

export interface ExecutionCheck {
  allowed: boolean;
  reason?: "not_in_current_version" | "not_approved";
}

/** Só se executa item da versão publicada vigente com aprovação (própria ou herdada). */
export function canExecuteItem(status: ItemStatus | null, inCurrentVersion: boolean): ExecutionCheck {
  if (!inCurrentVersion) return { allowed: false, reason: "not_in_current_version" };
  if (status === "approved" || status === "approved_inherited") return { allowed: true };
  return { allowed: false, reason: "not_approved" };
}

export interface StatusInputItem {
  id: string;
  lineKey: string;
  hash: string;
  /** Decisão registrada neste item (append-only), se houver. */
  ownDecision: "approved" | "rejected" | null;
}
export interface StatusInputVersion {
  versionNo: number;
  items: StatusInputItem[];
}

/**
 * Status efetivo por item. Herança só a partir da versão IMEDIATAMENTE anterior: o item precisa
 * existir lá com a mesma lineKey, hash idêntico e estar aprovado (própria ou herdada).
 * Se a linha sai de uma versão, a cadeia se quebra. Recusa não é herdada.
 */
export function computeEffectiveStatuses(versions: readonly StatusInputVersion[]): Map<string, ItemStatus> {
  const out = new Map<string, ItemStatus>();
  let prev = new Map<string, { hash: string; approved: boolean }>();
  for (const v of [...versions].sort((a, b) => a.versionNo - b.versionNo)) {
    const next = new Map<string, { hash: string; approved: boolean }>();
    for (const it of v.items) {
      let st: ItemStatus;
      if (it.ownDecision === "approved") st = "approved";
      else if (it.ownDecision === "rejected") st = "rejected";
      else {
        const p = prev.get(it.lineKey);
        st = p && p.approved && p.hash === it.hash ? "approved_inherited" : "pending";
      }
      out.set(it.id, st);
      next.set(it.lineKey, { hash: it.hash, approved: st === "approved" || st === "approved_inherited" });
    }
    prev = next;
  }
  return out;
}
