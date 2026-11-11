import { discountNeedsOverride, installmentStatus, lateCharges, splitCents, buildDre, overheadForOrder, allocateProRata } from "@autoflow/shared";
import { z } from "zod";
import { audit } from "../audit";
import { sha256Hex } from "../crypto";
import type { Q } from "../db";
import { HttpError, conflict, forbidden, notFound, parseJson } from "../http";
import type { Router } from "../router";
import type { Deps, TenantPrincipal } from "../types";
import { loadModel, present } from "./estimates";
import { tctx } from "./tenant";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, "data inválida");
const cents = z.number().int().min(1).max(100_000_000_00);
const Plan = z.object({ count: z.number().int().min(1).max(36), firstDueDate: date, intervalDays: z.number().int().min(1).max(365).default(30) });
const TODAY = "(now() at time zone 'America/Sao_Paulo')::date";
const N = (v: unknown) => Number(v ?? 0);

const SYSTEM_ACCOUNTS: [string, string, string, string][] = [
  ["receivable", "1.1.01", "Contas a receber", "asset"], ["payable", "2.1.01", "Contas a pagar", "liability"],
  ["opening_equity", "3.1.01", "Saldo de abertura", "equity"],
  ["revenue_services", "4.1.01", "Receita de serviços", "revenue"], ["revenue_parts", "4.1.02", "Receita de peças e outros", "revenue"],
  ["deductions", "4.9.01", "Descontos concedidos", "deduction"], ["interest_income", "7.1.01", "Juros e multa recebidos", "financial"],
  ["cost_parts", "5.1.01", "Peças", "direct_cost"], ["cost_materials", "5.1.02", "Materiais", "direct_cost"],
  ["cost_third_party", "5.1.03", "Serviços terceirizados", "direct_cost"], ["cost_other_direct", "5.1.09", "Outros custos diretos", "direct_cost"],
  ["exp_rent", "6.1.01", "Aluguel", "expense"], ["exp_utilities", "6.1.02", "Energia, água e internet", "expense"],
  ["exp_payroll", "6.1.03", "Folha e encargos", "expense"], ["exp_taxes", "6.1.04", "Impostos e taxas", "expense"], ["exp_other", "6.1.09", "Outras despesas", "expense"],
];

async function ensureChart(q: Q, tenantId: string) {
  const n = await q.one<{ n: number }>("select count(*)::int n from fin_accounts where system_key is not null");
  if (n!.n === 0) for (const [k, code, name, type] of SYSTEM_ACCOUNTS) await q.query("insert into fin_accounts (tenant_id, code, name, type, system_key) values ($1,$2,$3,$4,$5) on conflict do nothing", [tenantId, code, name, type, k]);
}
async function sysAcc(q: Q, key: string): Promise<string> {
  const a = await q.one<{ id: string }>("select id from fin_accounts where system_key = $1", [key]);
  if (!a) throw new HttpError(500, "chart_missing");
  return a.id;
}
async function settings(q: Q, tenantId: string) {
  await q.query("insert into fin_settings (tenant_id) values ($1) on conflict do nothing", [tenantId]);
  return (await q.one<any>("select * from fin_settings"))!;
}

interface Entry { account: string; side: "D" | "C"; amount: number; costCenterId?: string | null }
interface Txn { tenantId: string; unitId: string; kind: string; competence?: string; cash?: string | null; description: string; osId?: string | null; userId: string; entries: Entry[] }
async function postTxn(q: Q, t: Txn): Promise<string> {
  const x = await q.one<{ id: string }>(
    `insert into ledger_txns (tenant_id, unit_id, kind, competence_date, cash_date, description, os_id, created_by)
     values ($1,$2,$3, coalesce($4::date, ${TODAY}), $5, $6, $7, $8) returning id`,
    [t.tenantId, t.unitId, t.kind, t.competence ?? null, t.cash ?? null, t.description, t.osId ?? null, t.userId]);
  for (const e of t.entries.filter((e) => e.amount > 0))
    await q.query("insert into ledger_entries (tenant_id, unit_id, txn_id, account_id, side, amount_cents, cost_center_id) values ($1,$2,$3,$4,$5,$6,$7)",
      [t.tenantId, t.unitId, x!.id, e.account, e.side, e.amount, e.costCenterId ?? null]);
  return x!.id;
}
/** Estorno = nova txn com lados invertidos (nunca UPDATE/DELETE). */
async function reverseTxn(q: Q, p: TenantPrincipal, txnId: string, reason: string): Promise<string> {
  const t = await q.one<{ unit_id: string; description: string; cash_date: string | null; os_id: string | null; kind: string }>("select unit_id, description, cash_date::text, os_id, kind from ledger_txns where id = $1", [txnId]);
  if (!t) throw notFound("txn_not_found");
  if (t.kind === "reversal") throw conflict("cannot_reverse_reversal");
  const es = await q.many<{ account_id: string; side: "D" | "C"; amount_cents: string; cost_center_id: string | null }>("select account_id, side, amount_cents, cost_center_id from ledger_entries where txn_id = $1", [txnId]);
  const rev = await q.one<{ id: string }>(
    `insert into ledger_txns (tenant_id, unit_id, kind, competence_date, cash_date, description, os_id, reversal_of, reversal_reason, created_by)
     values ($1,$2,'reversal', ${TODAY}, case when $3::date is null then null else ${TODAY} end, $4, $5, $6, $7, $8) returning id`,
    [p.tenantId, t.unit_id, t.cash_date, `Estorno: ${t.description}`.slice(0, 200), t.os_id, txnId, reason, p.userId]);
  for (const e of es) await q.query("insert into ledger_entries (tenant_id, unit_id, txn_id, account_id, side, amount_cents, cost_center_id) values ($1,$2,$3,$4,$5,$6,$7)",
    [p.tenantId, t.unit_id, rev!.id, e.account_id, e.side === "D" ? "C" : "D", e.amount_cents, e.cost_center_id]);
  return rev!.id;
}
const needOverride = (p: TenantPrincipal, over: boolean) => { if (over && !p.permissions.has("finance:override")) throw forbidden("override_required"); };

const InstSelect = `
  select i.id, i.doc_id, i.no, i.due_date::text as due_date, i.amount_cents, d.kind, d.description, d.party_name, d.customer_id, d.os_id, d.unit_id,
         d.cancelled_at is not null as cancelled,
         coalesce((select sum(a.principal_cents) from fin_allocations a join fin_settlements s on s.tenant_id = a.tenant_id and s.id = a.settlement_id
                    where a.installment_id = i.id and s.reversed_at is null), 0)::bigint as paid_cents
    from fin_installments i join fin_documents d on d.tenant_id = i.tenant_id and d.id = i.doc_id`;
const presentInst = (r: any, today: string) => {
  const paid = N(r.paid_cents);
  return { id: r.id, docId: r.doc_id, no: r.no, dueDate: r.due_date, amountCents: N(r.amount_cents), paidCents: paid, openCents: r.cancelled ? 0 : N(r.amount_cents) - paid,
    status: installmentStatus({ amountCents: N(r.amount_cents), paidCents: paid, dueDate: r.due_date, today, cancelled: r.cancelled }),
    kind: r.kind, description: r.description, party: r.party_name, customerId: r.customer_id, osId: r.os_id, unitId: r.unit_id };
};
const todayOf = async (q: Q) => (await q.one<{ d: string }>(`select ${TODAY}::text as d`))!.d;

async function createInstallments(q: Q, tenantId: string, docId: string, net: number, plan: z.infer<typeof Plan>) {
  const parts = splitCents(net, plan.count);
  for (const [i, amt] of parts.entries())
    await q.query("insert into fin_installments (tenant_id, doc_id, no, due_date, amount_cents) values ($1,$2,$3,$4::date + $5::int, $6)", [tenantId, docId, i + 1, plan.firstDueDate, i * plan.intervalDays, amt]);
}

export function registerFinanceRoutes(r: Router, deps: Deps): void {
  const READ = { auth: "tenant", permission: "finance:read" } as const;
  const MANAGE = { auth: "tenant", permission: "finance:manage" } as const;
  const RECEIVE = { auth: "tenant", permission: "finance:receive" } as const;
  const SETTINGS = { auth: "tenant", permission: "finance:settings" } as const;
  const tx = <T>(p: TenantPrincipal, fn: (q: Q) => Promise<T>) => deps.db.tx(tctx(p), fn);
  const defaultUnit = async (q: Q) => (await q.one<{ id: string }>("select id from units where is_default order by created_at limit 1"))?.id;

  // ---- Configuração / plano de contas / centros de custo / carteiras ----
  r.get("/finance/settings", READ, async (c) => { const p = c.get("tenant"); return c.json(await tx(p, (q) => settings(q, p.tenantId))); });
  r.put("/finance/settings", SETTINGS, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ discountLimitBp: z.number().int().min(0).max(10000), reversalLimitCents: z.number().int().min(0), lateFineBp: z.number().int().min(0).max(10000),
      lateInterestBpMonth: z.number().int().min(0).max(10000), overheadMethod: z.enum(["revenue", "hours", "fixed"]), overheadValue: z.number().int().min(0) }).partial());
    await tx(p, async (q) => {
      await settings(q, p.tenantId);
      await q.query(`update fin_settings set discount_limit_bp = coalesce($1,discount_limit_bp), reversal_limit_cents = coalesce($2,reversal_limit_cents), late_fine_bp = coalesce($3,late_fine_bp),
        late_interest_bp_month = coalesce($4,late_interest_bp_month), overhead_method = coalesce($5,overhead_method), overhead_value = coalesce($6,overhead_value), updated_at = now()`,
        [b.discountLimitBp ?? null, b.reversalLimitCents ?? null, b.lateFineBp ?? null, b.lateInterestBpMonth ?? null, b.overheadMethod ?? null, b.overheadValue ?? null]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "finance.settings", entityType: "settings", entityId: p.tenantId, requestId: c.get("requestId"), metadata: b });
    });
    return c.json({ ok: true });
  });
  r.get("/finance/accounts", READ, async (c) => {
    const p = c.get("tenant");
    return c.json({ accounts: await tx(p, async (q) => { await ensureChart(q, p.tenantId); return q.many("select id, code, name, type, system_key, active from fin_accounts order by code"); }) });
  });
  r.post("/finance/accounts", MANAGE, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ code: z.string().regex(/^[A-Za-z0-9._-]{1,20}$/), name: z.string().trim().min(2).max(80), type: z.enum(["revenue", "direct_cost", "expense", "financial"]) }));
    return c.json(await tx(p, async (q) => { await ensureChart(q, p.tenantId); return q.one("insert into fin_accounts (tenant_id, code, name, type) values ($1,$2,$3,$4) returning id", [p.tenantId, b.code, b.name, b.type]); }), 201);
  });
  r.get("/finance/cost-centers", READ, async (c) => { const p = c.get("tenant"); return c.json({ costCenters: await tx(p, (q) => q.many("select id, unit_id, name, active from cost_centers order by name")) }); });
  r.post("/finance/cost-centers", MANAGE, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ name: z.string().trim().min(2).max(80), unitId: uuid.optional() }));
    return c.json(await tx(p, (q) => q.one("insert into cost_centers (tenant_id, unit_id, name) values ($1,$2,$3) returning id", [p.tenantId, b.unitId ?? null, b.name])), 201);
  });

  r.get("/finance/wallets", RECEIVE, async (c) => {
    const p = c.get("tenant");
    const showBal = p.permissions.has("finance:read");
    const rows = await tx(p, (q) => q.many<any>(
      `select w.id, w.name, w.kind, w.active,
              (select coalesce(sum(case e.side when 'D' then e.amount_cents else -e.amount_cents end),0) from ledger_entries e where e.tenant_id = w.tenant_id and e.account_id = w.account_id)::bigint as balance
         from fin_wallets w order by w.name`));
    return c.json({ wallets: rows.map((w) => ({ id: w.id, name: w.name, kind: w.kind, active: w.active, ...(showBal ? { balanceCents: N(w.balance) } : {}) })) });
  });
  r.post("/finance/wallets", MANAGE, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ name: z.string().trim().min(2).max(80), kind: z.enum(["cash", "bank", "card_machine", "digital"]), openingBalanceCents: z.number().int().min(0).max(100_000_000_00).default(0), unitId: uuid.optional() }));
    const row = await tx(p, async (q) => {
      await ensureChart(q, p.tenantId);
      const n = await q.one<{ n: number }>("select count(*)::int + 1 as n from fin_wallets");
      const acc = await q.one<{ id: string }>("insert into fin_accounts (tenant_id, code, name, type) values ($1,$2,$3,'asset') returning id", [p.tenantId, `1.0.${String(n!.n).padStart(3, "0")}`, `Carteira: ${b.name}`.slice(0, 80)]);
      const w = await q.one<{ id: string }>("insert into fin_wallets (tenant_id, name, kind, account_id) values ($1,$2,$3,$4) returning id", [p.tenantId, b.name, b.kind, acc!.id]);
      if (b.openingBalanceCents > 0) {
        const unit = b.unitId ?? (await defaultUnit(q));
        if (!unit) throw new HttpError(422, "unit_required");
        await postTxn(q, { tenantId: p.tenantId, unitId: unit, kind: "opening", cash: await todayOf(q), description: `Saldo de abertura: ${b.name}`, userId: p.userId,
          entries: [{ account: acc!.id, side: "D", amount: b.openingBalanceCents }, { account: await sysAcc(q, "opening_equity"), side: "C", amount: b.openingBalanceCents }] });
      }
      return w;
    });
    return c.json(row, 201);
  });
  r.post("/finance/transfers", MANAGE, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ fromWalletId: uuid, toWalletId: uuid, amountCents: cents, date: date.optional(), unitId: uuid.optional() }));
    if (b.fromWalletId === b.toWalletId) throw new HttpError(422, "same_wallet");
    const id = await tx(p, async (q) => {
      const ws = await q.many<{ id: string; account_id: string }>("select id, account_id from fin_wallets where id = any($1::uuid[]) and active", [[b.fromWalletId, b.toWalletId]]);
      const f = ws.find((w) => w.id === b.fromWalletId); const t = ws.find((w) => w.id === b.toWalletId);
      if (!f || !t) throw notFound("wallet_not_found");
      const unit = b.unitId ?? (await defaultUnit(q));
      return postTxn(q, { tenantId: p.tenantId, unitId: unit!, kind: "transfer", cash: b.date ?? (await todayOf(q)), competence: b.date, description: "Transferência entre carteiras", userId: p.userId,
        entries: [{ account: t.account_id, side: "D", amount: b.amountCents }, { account: f.account_id, side: "C", amount: b.amountCents }] });
    });
    return c.json({ txnId: id }, 201);
  });

  // ---- Faturamento (somente OS entregue; só itens aprovados) ----
  r.post("/orders/:id/invoice", MANAGE, async (c) => {
    const p = c.get("tenant"); const osId = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ discountCents: z.number().int().min(0).default(0), discountReason: z.string().trim().min(5).max(300).optional(), plan: Plan }));
    const out = await tx(p, async (q) => {
      await ensureChart(q, p.tenantId);
      const o = await q.one<{ id: string; unit_id: string; customer_id: string; status: string; number: number }>("select id, unit_id, customer_id, status, number from service_orders where id = $1 for update", [osId]);
      if (!o) throw notFound("order_not_found");
      if (o.status !== "delivered") throw conflict("order_not_delivered");
      if (await q.one("select 1 from fin_documents where os_id = $1 and kind = 'receivable' and cancelled_at is null", [osId])) throw conflict("already_invoiced");
      const cur = (await loadModel(q, osId)).versions.find((v) => v.status === "published");
      const approved = (cur?.items ?? []).map(present).filter((i) => i.status === "approved" || i.status === "approved_inherited");
      const gross = approved.reduce((s, i) => s + i.totalCents, 0);
      if (gross <= 0) throw conflict("no_approved_items");
      if (b.discountCents >= gross) throw new HttpError(422, "discount_too_large");
      if (b.discountCents > 0) {
        if (!p.permissions.has("finance:discount")) throw forbidden("discount_not_allowed");
        if (!b.discountReason) throw new HttpError(422, "discount_reason_required");
        const st = await settings(q, p.tenantId);
        needOverride(p, discountNeedsOverride(gross, b.discountCents, st.discount_limit_bp));
      }
      const svc = approved.filter((i) => i.category === "service").reduce((s, i) => s + i.totalCents, 0);
      const net = gross - b.discountCents;
      const txnId = await postTxn(q, { tenantId: p.tenantId, unitId: o.unit_id, kind: "invoice", osId, description: `Faturamento OS ${o.number}`, userId: p.userId, entries: [
        { account: await sysAcc(q, "receivable"), side: "D", amount: net }, { account: await sysAcc(q, "deductions"), side: "D", amount: b.discountCents },
        { account: await sysAcc(q, "revenue_services"), side: "C", amount: svc }, { account: await sysAcc(q, "revenue_parts"), side: "C", amount: gross - svc }] });
      const doc = await q.one<{ id: string }>(
        `insert into fin_documents (tenant_id, unit_id, kind, os_id, customer_id, description, gross_cents, discount_cents, net_cents, competence_date, txn_id, created_by)
         values ($1,$2,'receivable',$3,$4,$5,$6,$7,$8, ${TODAY}, $9, $10) returning id`,
        [p.tenantId, o.unit_id, osId, o.customer_id, `Faturamento OS ${o.number}`, gross, b.discountCents, net, txnId, p.userId]);
      await createInstallments(q, p.tenantId, doc!.id, net, b.plan);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "finance.invoice", entityType: "document", entityId: doc!.id, requestId: c.get("requestId"), metadata: { grossCents: gross, discountCents: b.discountCents, reason: b.discountReason } });
      return { id: doc!.id, grossCents: gross, discountCents: b.discountCents, netCents: net };
    });
    return c.json(out, 201);
  });

  // ---- Contas a pagar ----
  r.post("/finance/payables", MANAGE, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ unitId: uuid, partyName: z.string().trim().min(2).max(120), accountId: uuid, description: z.string().trim().min(2).max(200), totalCents: cents,
      competenceDate: date.optional(), costCenterId: uuid.optional(), osId: uuid.optional(), plan: Plan, repeatMonths: z.number().int().min(1).max(24).default(1) }));
    const ids = await tx(p, async (q) => {
      await ensureChart(q, p.tenantId);
      const acc = await q.one<{ type: string }>("select type from fin_accounts where id = $1 and active", [b.accountId]);
      if (!acc || !["direct_cost", "expense", "financial"].includes(acc.type)) throw new HttpError(422, "invalid_account");
      if (b.osId && acc.type !== "direct_cost") throw new HttpError(422, "os_requires_direct_cost");
      if (b.osId && !(await q.one("select 1 from service_orders where id = $1 and unit_id = $2", [b.osId, b.unitId]))) throw notFound("order_not_found");
      const out: string[] = [];
      for (let m = 0; m < b.repeatMonths; m++) {
        const shift = async (d: string) => (await q.one<{ d: string }>("select ($1::date + make_interval(months => $2))::date::text as d", [d, m]))!.d;
        const comp = await shift(b.competenceDate ?? (await todayOf(q)));
        const txnId = await postTxn(q, { tenantId: p.tenantId, unitId: b.unitId, kind: "payable", competence: comp, description: b.description, osId: b.osId, userId: p.userId,
          entries: [{ account: b.accountId, side: "D", amount: b.totalCents, costCenterId: b.costCenterId }, { account: await sysAcc(q, "payable"), side: "C", amount: b.totalCents }] });
        const doc = await q.one<{ id: string }>(
          `insert into fin_documents (tenant_id, unit_id, kind, os_id, party_name, account_id, cost_center_id, description, gross_cents, net_cents, competence_date, txn_id, created_by)
           values ($1,$2,'payable',$3,$4,$5,$6,$7,$8,$8,$9,$10,$11) returning id`,
          [p.tenantId, b.unitId, b.osId ?? null, b.partyName, b.accountId, b.costCenterId ?? null, b.description, b.totalCents, comp, txnId, p.userId]);
        await createInstallments(q, p.tenantId, doc!.id, b.totalCents, { ...b.plan, firstDueDate: await shift(b.plan.firstDueDate) });
        out.push(doc!.id);
      }
      return out;
    });
    return c.json({ ids }, 201);
  });

  // ---- Listas (status derivado) ----
  const list = (kind: "receivable" | "payable") => async (c: any) => {
    const p = c.get("tenant") as TenantPrincipal;
    const status = c.req.query("status"); const from = c.req.query("from"); const to = c.req.query("to");
    if (status) z.enum(["open", "partial", "paid", "overdue", "cancelled"]).parse(status);
    if (from) date.parse(from); if (to) date.parse(to);
    const rows = await tx(p, async (q) => {
      const today = await todayOf(q);
      const rs = await q.many<any>(`${InstSelect} where d.kind = $1 and ($2::date is null or i.due_date >= $2) and ($3::date is null or i.due_date <= $3) order by i.due_date, i.id limit 500`, [kind, from ?? null, to ?? null]);
      return rs.map((x) => presentInst(x, today)).filter((x) => !status || x.status === status);
    });
    return c.json({ installments: rows });
  };
  r.get("/finance/receivables", READ, list("receivable"));
  r.get("/finance/payables", READ, list("payable"));

  r.get("/finance/installments/:id/quote", RECEIVE, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const on = c.req.query("on"); if (on) date.parse(on);
    const out = await tx(p, async (q) => {
      const row = await q.one<any>(`${InstSelect} where i.id = $1`, [id]); if (!row) throw notFound("installment_not_found");
      const today = await todayOf(q); const inst = presentInst(row, today); const st = await settings(q, p.tenantId);
      const ch = inst.kind === "receivable" ? lateCharges({ principalCents: inst.openCents, dueDate: inst.dueDate, on: on ?? today, fineBp: st.late_fine_bp, interestBpMonth: st.late_interest_bp_month }) : { days: 0, fineCents: 0, interestCents: 0, ruleVersion: "v1" };
      return { ...inst, charges: ch, totalDueCents: inst.openCents + ch.fineCents + ch.interestCents };
    });
    return c.json(out);
  });

  // ---- Recebimentos / pagamentos (idempotentes, serializados por documento) ----
  const SettleBody = z.object({ walletId: uuid, settledOn: date.optional(), method: z.enum(["cash", "pix", "card", "transfer", "boleto", "other"]),
    allocations: z.array(z.object({ installmentId: uuid, principalCents: cents })).min(1).max(36), waiveCharges: z.boolean().default(false) });
  const settle = (kind: "receipt" | "payment") => async (c: any) => {
    const p = c.get("tenant") as TenantPrincipal;
    const key = c.req.header("idempotency-key") ?? "";
    if (key.length < 8 || key.length > 80) throw new HttpError(422, "idempotency_key_required");
    const b = await parseJson(c, SettleBody);
    if (new Set(b.allocations.map((a) => a.installmentId)).size !== b.allocations.length) throw new HttpError(422, "duplicate_installment");
    if (b.waiveCharges && !p.permissions.has("finance:discount")) throw forbidden("discount_not_allowed");
    const reqHash = await sha256Hex(JSON.stringify([b.walletId, b.settledOn ?? null, b.method, [...b.allocations].sort((x, y) => x.installmentId.localeCompare(y.installmentId)), b.waiveCharges]));
    const res = await tx(p, async (q) => {
      await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${p.tenantId}:${kind}:${key}`]);
      const prior = await q.one<{ id: string; request_hash: string; principal_cents: string; charges_cents: string }>("select id, request_hash, principal_cents, charges_cents from fin_settlements where kind = $1 and idempotency_key = $2", [kind, key]);
      if (prior) { if (prior.request_hash !== reqHash) throw conflict("idempotency_key_reuse"); return { replayed: true, id: prior.id, principalCents: N(prior.principal_cents), chargesCents: N(prior.charges_cents) }; }
      await ensureChart(q, p.tenantId);
      const wallet = await q.one<{ id: string; account_id: string }>("select id, account_id from fin_wallets where id = $1 and active", [b.walletId]);
      if (!wallet) throw notFound("wallet_not_found");
      const ids = b.allocations.map((a) => a.installmentId);
      const docs = await q.many<{ id: string }>("select d.id from fin_documents d where d.id in (select doc_id from fin_installments where id = any($1::uuid[])) order by d.id for update", [ids]);
      void docs;
      const today = await todayOf(q); const on = b.settledOn ?? today;
      if (on > today) throw new HttpError(422, "future_date");
      const rows = await q.many<any>(`${InstSelect} where i.id = any($1::uuid[])`, [ids]);
      if (rows.length !== ids.length) throw notFound("installment_not_found");
      const st = await settings(q, p.tenantId);
      let principal = 0, charges = 0; const lines: any[] = [];
      for (const a of b.allocations) {
        const row = rows.find((x) => x.id === a.installmentId);
        if (row.kind !== (kind === "receipt" ? "receivable" : "payable")) throw new HttpError(422, "wrong_document_kind");
        if (row.cancelled) throw conflict("document_cancelled");
        if (a.principalCents > N(row.amount_cents) - N(row.paid_cents)) throw conflict("exceeds_open_amount");
        const ch = kind === "receipt" && !b.waiveCharges ? lateCharges({ principalCents: a.principalCents, dueDate: row.due_date, on, fineBp: st.late_fine_bp, interestBpMonth: st.late_interest_bp_month }) : { fineCents: 0, interestCents: 0 };
        principal += a.principalCents; charges += ch.fineCents + ch.interestCents;
        lines.push({ ...a, unit: row.unit_id, interest: ch.interestCents, fine: ch.fineCents });
      }
      const unit = lines[0].unit as string;
      if (lines.some((l) => l.unit !== unit)) throw new HttpError(422, "mixed_units");
      const entries: Entry[] = kind === "receipt"
        ? [{ account: wallet.account_id, side: "D", amount: principal + charges }, { account: await sysAcc(q, "receivable"), side: "C", amount: principal }, { account: await sysAcc(q, "interest_income"), side: "C", amount: charges }]
        : [{ account: await sysAcc(q, "payable"), side: "D", amount: principal }, { account: wallet.account_id, side: "C", amount: principal }];
      const txnId = await postTxn(q, { tenantId: p.tenantId, unitId: unit, kind, competence: on, cash: on, description: kind === "receipt" ? "Recebimento" : "Pagamento", userId: p.userId, entries });
      const s = await q.one<{ id: string }>(
        `insert into fin_settlements (tenant_id, unit_id, kind, wallet_id, principal_cents, charges_cents, settled_on, method, idempotency_key, request_hash, txn_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`, [p.tenantId, unit, kind, b.walletId, principal, charges, on, b.method, key, reqHash, txnId, p.userId]);
      for (const l of lines) await q.query("insert into fin_allocations (tenant_id, settlement_id, installment_id, principal_cents, interest_cents, fine_cents) values ($1,$2,$3,$4,$5,$6)", [p.tenantId, s!.id, l.installmentId, l.principalCents, l.interest, l.fine]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: `finance.${kind}`, entityType: "settlement", entityId: s!.id, requestId: c.get("requestId"), metadata: { principalCents: principal, chargesCents: charges, waived: b.waiveCharges } });
      return { replayed: false, id: s!.id, principalCents: principal, chargesCents: charges };
    });
    return c.json(res, res.replayed ? 200 : 201);
  };
  r.post("/finance/receipts", RECEIVE, settle("receipt"));
  r.post("/finance/payments", MANAGE, settle("payment"));

  // ---- Estornos e cancelamentos (alçada) ----
  r.post("/finance/settlements/:id/reverse", { auth: "tenant", permission: "finance:reverse" }, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ reason: z.string().trim().min(3).max(300) }));
    const out = await tx(p, async (q) => {
      const s = await q.one<{ txn_id: string; principal_cents: string; charges_cents: string; reversed_at: Date | null }>("select txn_id, principal_cents, charges_cents, reversed_at from fin_settlements where id = $1 for update", [id]);
      if (!s) throw notFound("settlement_not_found");
      if (s.reversed_at) throw conflict("already_reversed");
      const st = await settings(q, p.tenantId);
      needOverride(p, N(s.principal_cents) + N(s.charges_cents) > N(st.reversal_limit_cents));
      const rev = await reverseTxn(q, p, s.txn_id, b.reason);
      await q.query(`update fin_settlements set reversed_at = now(), reversed_on = ${TODAY}, reversal_reason = $2 where id = $1`, [id, b.reason]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "finance.settlement_reverse", entityType: "settlement", entityId: id, requestId: c.get("requestId"), metadata: { reason: b.reason } });
      return { reversalTxnId: rev };
    });
    return c.json(out);
  });
  r.post("/finance/documents/:id/cancel", { auth: "tenant", permission: "finance:reverse" }, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ reason: z.string().trim().min(3).max(300) }));
    const out = await tx(p, async (q) => {
      const d = await q.one<{ txn_id: string; net_cents: string; cancelled_at: Date | null }>("select txn_id, net_cents, cancelled_at from fin_documents where id = $1 for update", [id]);
      if (!d) throw notFound("document_not_found");
      if (d.cancelled_at) throw conflict("already_cancelled");
      if (await q.one("select 1 from fin_allocations a join fin_settlements s on s.tenant_id = a.tenant_id and s.id = a.settlement_id join fin_installments i on i.tenant_id = a.tenant_id and i.id = a.installment_id where i.doc_id = $1 and s.reversed_at is null", [id])) throw conflict("has_settlements");
      const st = await settings(q, p.tenantId);
      needOverride(p, N(d.net_cents) > N(st.reversal_limit_cents));
      const rev = await reverseTxn(q, p, d.txn_id, b.reason);
      await q.query("update fin_documents set cancelled_at = now(), cancel_reason = $2 where id = $1", [id, b.reason]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "finance.document_cancel", entityType: "document", entityId: id, requestId: c.get("requestId"), metadata: { reason: b.reason } });
      return { reversalTxnId: rev };
    });
    return c.json(out);
  });

  // ---- Conciliação básica ----
  r.post("/finance/wallets/:id/statement", MANAGE, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ lines: z.array(z.object({ date, description: z.string().trim().min(1).max(200), amountCents: z.number().int().refine((v) => v !== 0), externalRef: z.string().max(80).optional() })).min(1).max(500) }));
    const n = await tx(p, async (q) => {
      if (!(await q.one("select 1 from fin_wallets where id = $1", [id]))) throw notFound("wallet_not_found");
      let ins = 0;
      for (const l of b.lines) ins += (await q.query("insert into bank_statement_lines (tenant_id, wallet_id, line_date, description, amount_cents, external_ref) values ($1,$2,$3,$4,$5,$6) on conflict do nothing", [p.tenantId, id, l.date, l.description, l.amountCents, l.externalRef ?? null])).rowCount ?? 0;
      return ins;
    });
    return c.json({ imported: n }, 201);
  });
  r.get("/finance/wallets/:id/reconciliation", READ, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const out = await tx(p, async (q) => {
      const lines = await q.many<any>("select id, line_date::text, description, amount_cents from bank_statement_lines where wallet_id = $1 and matched_entry_id is null order by line_date", [id]);
      const out = [];
      for (const l of lines) {
        const sug = await q.many<any>(
          `select e.id as entry_id, t.cash_date::text, t.description from ledger_entries e join ledger_txns t on t.tenant_id = e.tenant_id and t.id = e.txn_id
             join fin_wallets w on w.tenant_id = e.tenant_id and w.account_id = e.account_id
            where w.id = $1 and (case e.side when 'D' then e.amount_cents else -e.amount_cents end) = $2 and t.cash_date between $3::date - 3 and $3::date + 3
              and not exists (select 1 from bank_statement_lines b where b.matched_entry_id = e.id) order by abs(t.cash_date - $3::date), e.id limit 3`, [id, l.amount_cents, l.line_date]);
        out.push({ lineId: l.id, date: l.line_date, description: l.description, amountCents: N(l.amount_cents), suggestions: sug.map((s) => ({ entryId: N(s.entry_id), cashDate: s.cash_date, description: s.description })) });
      }
      return out;
    });
    return c.json({ unmatched: out });
  });
  r.post("/finance/reconciliation/match", MANAGE, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ lineId: uuid, entryId: z.number().int().min(1) }));
    await tx(p, async (q) => {
      const l = await q.one<any>("select wallet_id, amount_cents, matched_entry_id from bank_statement_lines where id = $1 for update", [b.lineId]);
      if (!l) throw notFound("line_not_found");
      if (l.matched_entry_id) throw conflict("already_matched");
      const e = await q.one<any>(`select (case e.side when 'D' then e.amount_cents else -e.amount_cents end) as signed from ledger_entries e join fin_wallets w on w.tenant_id = e.tenant_id and w.account_id = e.account_id where e.id = $1 and w.id = $2`, [b.entryId, l.wallet_id]);
      if (!e) throw notFound("entry_not_found");
      if (N(e.signed) !== N(l.amount_cents)) throw conflict("amount_mismatch");
      await q.query("update bank_statement_lines set matched_entry_id = $2, matched_at = now() where id = $1", [b.lineId, b.entryId]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "finance.reconcile", entityType: "statement_line", entityId: b.lineId, requestId: c.get("requestId") });
    });
    return c.json({ ok: true });
  });

  // ---- Relatórios gerenciais ----
  const range = (c: any) => { const q = z.object({ from: date, to: date, basis: z.enum(["accrual", "cash"]).default("accrual") }).parse({ ...Object.fromEntries(new URL(c.req.url).searchParams) }); return q; };
  async function dre(q: Q, from: string, to: string, basis: "accrual" | "cash") {
    if (basis === "accrual") {
      const rows = await q.many<{ type: string; net: string }>(
        `select a.type, sum(case when a.type in ('revenue','financial','liability','equity') then (case e.side when 'C' then e.amount_cents else -e.amount_cents end)
                                  else (case e.side when 'D' then e.amount_cents else -e.amount_cents end) end)::bigint as net
           from ledger_entries e join ledger_txns t on t.tenant_id = e.tenant_id and t.id = e.txn_id join fin_accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id
          where t.competence_date between $1 and $2 and a.type in ('revenue','deduction','direct_cost','expense','financial') group by a.type`, [from, to]);
      const g = (t: string) => N(rows.find((r) => r.type === t)?.net);
      return buildDre({ revenue: g("revenue"), deductions: g("deduction"), directCosts: g("direct_cost"), opex: g("expense"), financial: g("financial") });
    }
    const rows = await q.many<{ kind: string; atype: string | null; p: string; ch: string }>(
      `with ev as (
         select s.kind, a.installment_id, a.principal_cents p, a.interest_cents + a.fine_cents ch, s.settled_on d, 1 sg from fin_allocations a join fin_settlements s on s.tenant_id = a.tenant_id and s.id = a.settlement_id
         union all
         select s.kind, a.installment_id, a.principal_cents, a.interest_cents + a.fine_cents, s.reversed_on, -1 from fin_allocations a join fin_settlements s on s.tenant_id = a.tenant_id and s.id = a.settlement_id where s.reversed_at is not null)
       select ev.kind, fa.type as atype, sum(ev.sg * ev.p)::bigint as p, sum(ev.sg * ev.ch)::bigint as ch
         from ev join fin_installments i on i.id = ev.installment_id join fin_documents d on d.tenant_id = i.tenant_id and d.id = i.doc_id left join fin_accounts fa on fa.id = d.account_id
        where ev.d between $1 and $2 group by ev.kind, fa.type`, [from, to]);
    const sum = (f: (r: any) => boolean, k: "p" | "ch") => rows.filter(f).reduce((s, r) => s + N(r[k]), 0);
    return buildDre({ revenue: sum((r) => r.kind === "receipt", "p"), deductions: 0, directCosts: sum((r) => r.kind === "payment" && r.atype === "direct_cost", "p"),
      opex: sum((r) => r.kind === "payment" && r.atype === "expense", "p"), financial: sum((r) => r.kind === "receipt", "ch") - sum((r) => r.kind === "payment" && r.atype === "financial", "p") });
  }
  r.get("/finance/dre", READ, async (c) => {
    const p = c.get("tenant"); const { from, to, basis } = range(c);
    return c.json({ basis, from, to, ...(await tx(p, (q) => dre(q, from, to, basis))), note: basis === "cash" ? "Visão de caixa: receita = valores recebidos (líquidos de desconto), custos = valores pagos." : "Visão de competência a partir do ledger." });
  });
  r.get("/finance/balances", READ, async (c) => {
    const p = c.get("tenant");
    const rows = await tx(p, (q) => q.many<any>(`select w.id, w.name, coalesce(sum(case e.side when 'D' then e.amount_cents else -e.amount_cents end),0)::bigint as bal from fin_wallets w left join ledger_entries e on e.tenant_id = w.tenant_id and e.account_id = w.account_id group by w.id, w.name order by w.name`));
    return c.json({ wallets: rows.map((w) => ({ id: w.id, name: w.name, balanceCents: N(w.bal) })), totalCents: rows.reduce((s, w) => s + N(w.bal), 0) });
  });
  r.get("/finance/cashflow", READ, async (c) => {
    const p = c.get("tenant"); const { from, to } = range(c);
    const out = await tx(p, async (q) => {
      const real = await q.many<any>(
        `select to_char(t.cash_date, 'YYYY-MM') m, sum(case when e.side = 'D' then e.amount_cents else 0 end)::bigint inflow, sum(case when e.side = 'C' then e.amount_cents else 0 end)::bigint outflow
           from ledger_entries e join ledger_txns t on t.tenant_id = e.tenant_id and t.id = e.txn_id join fin_wallets w on w.tenant_id = e.tenant_id and w.account_id = e.account_id
          where t.cash_date between $1 and $2 and t.kind not in ('opening','transfer') group by 1`, [from, to]);
      const proj = await q.many<any>(
        `select to_char(x.due_date::date, 'YYYY-MM') m, sum(case when x.kind = 'receivable' then x.amount_cents - x.paid_cents else 0 end)::bigint inflow, sum(case when x.kind = 'payable' then x.amount_cents - x.paid_cents else 0 end)::bigint outflow
           from (${InstSelect}) x where not x.cancelled and x.due_date::date between $1 and $2 and x.amount_cents > x.paid_cents group by 1`, [from, to]);
      const months = [...new Set([...real.map((r) => r.m), ...proj.map((r) => r.m)])].sort();
      return months.map((m) => ({ month: m, realizedInCents: N(real.find((r) => r.m === m)?.inflow), realizedOutCents: N(real.find((r) => r.m === m)?.outflow),
        projectedInCents: N(proj.find((r) => r.m === m)?.inflow), projectedOutCents: N(proj.find((r) => r.m === m)?.outflow) }));
    });
    return c.json({ months: out, note: "Realizado = ledger de carteiras (exclui abertura e transferências); projetado = parcelas em aberto por vencimento." });
  });
  r.get("/finance/dashboard", READ, async (c) => {
    const p = c.get("tenant");
    const out = await tx(p, async (q) => {
      const t = await q.one<{ first: string; last: string; today: string; week: string }>(`select date_trunc('month', ${TODAY})::date::text first, (date_trunc('month', ${TODAY}) + interval '1 month - 1 day')::date::text last, ${TODAY}::text today, (${TODAY} + 7)::text week`);
      const acc = await dre(q, t!.first, t!.last, "accrual"); const cash = await dre(q, t!.first, t!.last, "cash");
      const bal = await q.one<{ b: string }>(`select coalesce(sum(case e.side when 'D' then e.amount_cents else -e.amount_cents end),0)::bigint b from fin_wallets w join ledger_entries e on e.tenant_id = w.tenant_id and e.account_id = w.account_id`);
      const od = await q.one<{ s: string; n: number }>(`select coalesce(sum(x.amount_cents - x.paid_cents),0)::bigint s, count(*)::int n from (${InstSelect}) x where x.kind = 'receivable' and not x.cancelled and x.amount_cents > x.paid_cents and x.due_date::date < ${TODAY}`);
      const due = await q.one<{ s: string }>(`select coalesce(sum(x.amount_cents - x.paid_cents),0)::bigint s from (${InstSelect}) x where x.kind = 'payable' and not x.cancelled and x.amount_cents > x.paid_cents and x.due_date::date between ${TODAY} and $1::date`, [t!.week]);
      return { label: "gerencial estimado", month: { from: t!.first, to: t!.last }, accrual: acc, cash, receivedInMonthCents: cash.grossRevenue, paidInMonthCents: cash.directCosts + cash.opex,
        totalBalanceCents: N(bal!.b), overdueReceivablesCents: N(od!.s), overdueReceivablesCount: od!.n, payablesNext7DaysCents: N(due!.s) };
    });
    return c.json(out);
  });

  // ---- Lucro por OS: margem de contribuição × resultado operacional estimado (separados) ----
  r.get("/orders/:id/profit", READ, async (c) => {
    const p = c.get("tenant"); const osId = uuid.parse(c.req.param("id"));
    const out = await tx(p, async (q) => {
      if (!(await q.one("select 1 from service_orders where id = $1", [osId]))) throw notFound("order_not_found");
      const inv = await q.one<{ gross_cents: string; discount_cents: string; net_cents: string }>("select gross_cents, discount_cents, net_cents from fin_documents where os_id = $1 and kind = 'receivable' and cancelled_at is null", [osId]);
      let gross: number, disc: number, source: "invoiced" | "approved_estimate";
      if (inv) { gross = N(inv.gross_cents); disc = N(inv.discount_cents); source = "invoiced"; }
      else {
        const cur = (await loadModel(q, osId)).versions.find((v) => v.status === "published");
        gross = (cur?.items ?? []).map(present).filter((i) => i.status.startsWith("approved")).reduce((s, i) => s + i.totalCents, 0); disc = 0; source = "approved_estimate";
      }
      const costs = await q.many<{ type: string; name: string; s: string }>(
        `select a.system_key as type, a.name, sum(d.net_cents)::bigint s from fin_documents d join fin_accounts a on a.tenant_id = d.tenant_id and a.id = d.account_id
          where d.os_id = $1 and d.kind = 'payable' and d.cancelled_at is null group by a.system_key, a.name`, [osId]);
      const lab = await q.one<{ minutes: string; cost: string; missing: boolean }>(
        `select coalesce(sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at))/60),0)::bigint minutes,
                coalesce(sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at)) * er.hourly_cost_cents / 3600),0)::bigint cost,
                coalesce(bool_or(er.membership_id is null), false) missing
           from task_time_entries e join production_tasks t on t.tenant_id = e.tenant_id and t.id = e.task_id
           left join employee_rates er on er.tenant_id = e.tenant_id and er.membership_id = e.membership_id where t.os_id = $1 and e.kind = 'work'`, [osId]);
      const st = await settings(q, p.tenantId);
      const net = gross - disc; const direct = costs.reduce((s, x) => s + N(x.s), 0); const labor = N(lab!.cost);
      const margin = net - direct - labor;
      const overhead = overheadForOrder({ method: st.overhead_method, value: N(st.overhead_value) }, { netRevenueCents: net, trackedMinutes: N(lab!.minutes) });
      // distribuição do desconto por categoria (rateio sem perda de centavos), útil para margem por tipo
      const split = gross > 0 ? allocateProRata(disc, [gross]) : [0];
      return { label: "gerencial estimado", revenueSource: source, grossRevenueCents: gross, discountCents: disc, netRevenueCents: net, directCosts: costs.map((x) => ({ account: x.name, cents: N(x.s) })), directCostsCents: direct,
        laborCents: labor, laborMinutes: N(lab!.minutes), laborRateMissing: lab!.missing, contributionMarginCents: margin, overheadMethod: st.overhead_method, overheadCents: overhead, estimatedOperatingResultCents: margin - overhead, discountAllocated: split };
    });
    return c.json(out);
  });
}
