import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lateCharges } from "@autoflow/shared";
import { hashPassword } from "../src/password";
import { Client, type Harness, type SeededTenant, PW, loginOwner, makeHarness, ownerSql, seedTenant, uniq } from "./harness";

let h: Harness;
beforeAll(() => { h = makeHarness(); });
afterAll(async () => h.db.close());

let ipn = 1;
const nextIp = () => `10.99.${Math.floor(ipn / 250)}.${(ipn++ % 250) + 1}`;
let keyN = 0;
const key = () => `key-${uniq("k")}-${keyN++}`;
const post = async (c: Client, path: string, body: unknown, k?: string) => Promise.resolve(h.app.request(path, {
  method: "POST", headers: { origin: "http://localhost:5173", "content-type": "application/json", "x-real-ip": nextIp(), ...(k ? { "idempotency-key": k } : {}), cookie: [...c.cookies].map(([a, b]) => `${a}=${b}`).join("; ") }, body: JSON.stringify(body),
})).then(async (r: Response) => ({ status: r.status, json: (await r.json()) as any }));

async function addMember(t: SeededTenant, role: string) {
  const email = `${uniq("m")}@example.test`;
  const u = await ownerSql<{ id: string }>("insert into users (email, password_hash) values ($1,$2) returning id", [email, await hashPassword(PW, 10)]);
  const r = await ownerSql<{ id: string }>("select id from roles where tenant_id is null and key = $1", [role]);
  await ownerSql("insert into memberships (tenant_id, user_id, role_id, status, all_units) values ($1,$2,$3,'active',true)", [t.tenantId, u[0]!.id, r[0]!.id]);
  const cl = new Client(h, nextIp());
  expect((await cl.post("/auth/login", { email, password: PW, tenantSlug: t.slug })).status).toBe(200);
  return cl;
}
async function setup() {
  const t = await seedTenant(h); const c = await loginOwner(h, t, nextIp());
  const cu = await c.post("/customers", { name: "Maria Silva", phone: "(71) 99999-1234" });
  const ve = await c.post(`/customers/${cu.json.id}/vehicles`, { plate: `FIN${Math.floor(Math.random() * 9)}${"ABCDEFGHJK"[Math.floor(Math.random() * 10)]}${Math.floor(Math.random() * 90 + 10)}`, make: "VW" });
  const wallet = await c.post("/finance/wallets", { name: "Caixa", kind: "cash", openingBalanceCents: 100000 });
  expect(wallet.status, JSON.stringify(wallet.json)).toBe(201);
  const mkOrder = async (items: [string, string, number][] = [["Troca de óleo", "service", 15000], ["Filtro", "part", 5000]], opts: { rejectLast?: boolean; deliver?: boolean } = {}) => {
    const o = await c.post("/orders", { customerId: cu.json.id, vehicleId: ve.json.id });
    for (const [description, category, unitPriceCents] of items) expect((await c.post(`/orders/${o.json.id}/estimate/items`, { description, category, qty: 1, unitPriceCents })).status).toBe(201);
    expect((await c.post(`/orders/${o.json.id}/estimate/publish`)).status).toBeLessThan(300);
    const est = (await c.get(`/orders/${o.json.id}/estimate`)).json.versions.find((v: any) => v.status === "published");
    const decisions = est.items.map((i: any, idx: number) => opts.rejectLast && idx === est.items.length - 1 ? { itemId: i.id, decision: "rejected", justification: "muito caro" } : { itemId: i.id, decision: "approved" });
    expect((await c.post(`/orders/${o.json.id}/estimate/decisions`, { customerName: "Maria", decisions })).status).toBe(201);
    if (opts.deliver !== false) expect((await c.patch(`/orders/${o.json.id}`, { status: "delivered" })).status).toBe(200);
    return o.json.id as string;
  };
  const invoice = (os: string, body: Record<string, unknown> = {}, cl = c) => cl.post(`/orders/${os}/invoice`, { plan: { count: 1, firstDueDate: "2030-01-10" }, ...body });
  const receive = (cl: Client, allocations: any[], extra: Record<string, unknown> = {}, k = key()) => post(cl, "/finance/receipts", { walletId: wallet.json.id, method: "pix", allocations, ...extra }, k);
  const installments = async (docId?: string) => (await c.get("/finance/receivables")).json.installments.filter((i: any) => !docId || i.docId === docId);
  return { t, c, mkOrder, invoice, receive, installments, walletId: wallet.json.id as string, customerId: cu.json.id as string };
}
const ledgerBalance = async (tenantId: string) => (await ownerSql<{ d: string }>("select coalesce(sum(case side when 'D' then amount_cents else -amount_cents end),0)::bigint d from ledger_entries where tenant_id = $1", [tenantId]))[0]!.d;

describe("F1/F2 ledger imutável e balanceado", () => {
  it("UPDATE/DELETE em ledger_entries/txns falham para o role da aplicação; txn desbalanceada é rejeitada no commit", async () => {
    const s = await setup();
    const ctx = { actor: "tenant", tenantId: s.t.tenantId, unitScope: "all" } as const;
    await expect(h.db.tx(ctx, (q) => q.query("update ledger_entries set amount_cents = amount_cents + 1"))).rejects.toThrow();
    await expect(h.db.tx(ctx, (q) => q.query("delete from ledger_entries"))).rejects.toThrow();
    await expect(h.db.tx(ctx, (q) => q.query("update ledger_txns set description = 'x'"))).rejects.toThrow();
    await expect(h.db.tx(ctx, (q) => q.query("delete from ledger_txns"))).rejects.toThrow();
    const acc = await ownerSql<{ id: string }>("select id from fin_accounts where tenant_id = $1 limit 2", [s.t.tenantId]);
    await expect(h.db.tx(ctx, async (q) => {
      const x = await q.one<{ id: string }>("insert into ledger_txns (tenant_id, unit_id, kind, competence_date, description) values ($1,$2,'payable', current_date,'x') returning id", [s.t.tenantId, s.t.unitIds[0]]);
      await q.query("insert into ledger_entries (tenant_id, unit_id, txn_id, account_id, side, amount_cents) values ($1,$2,$3,$4,'D',100)", [s.t.tenantId, s.t.unitIds[0], x!.id, acc[0]!.id]);
      await q.query("insert into ledger_entries (tenant_id, unit_id, txn_id, account_id, side, amount_cents) values ($1,$2,$3,$4,'C',99)", [s.t.tenantId, s.t.unitIds[0], x!.id, acc[1]!.id]);
    })).rejects.toThrow(/desbalanceada/);
    expect(await ledgerBalance(s.t.tenantId)).toBe("0");
  });
});

describe("F3 aprovação ≠ receita; faturamento só após entrega e só itens aprovados", () => {
  it("aprovar não lança; faturar antes da entrega 409; faturar após entrega usa só itens aprovados; segunda fatura 409", async () => {
    const s = await setup();
    const open = await s.mkOrder(undefined, { deliver: false });
    expect((await ownerSql("select 1 from ledger_txns where os_id = $1", [open]))).toHaveLength(0);
    const early = await s.invoice(open); expect(early.status).toBe(409); expect(early.json.error).toBe("order_not_delivered");
    const os = await s.mkOrder([["Serviço A", "service", 10000], ["Peça B", "part", 4000], ["Item recusado", "other", 99999]], { rejectLast: true });
    const inv = await s.invoice(os); expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    expect(inv.json.grossCents).toBe(14000);
    expect((await s.invoice(os)).json.error).toBe("already_invoiced");
    const rev = await ownerSql<{ n: string }>("select sum(e.amount_cents)::bigint n from ledger_entries e join fin_accounts a on a.id = e.account_id where a.type = 'revenue' and e.side = 'C' and e.tenant_id = $1", [s.t.tenantId]);
    expect(rev[0]!.n).toBe("14000");
    expect(await ledgerBalance(s.t.tenantId)).toBe("0");
  });
});

describe("F4 recebimentos, parcelas, estorno, cancelamento", () => {
  it("parcelas com resto na última; recebimento parcial; quitação por várias parcelas; estorno; cancelamento da fatura", async () => {
    const s = await setup(); const os = await s.mkOrder([["Serviço", "service", 10000]]);
    const inv = await s.invoice(os, { plan: { count: 3, firstDueDate: "2030-01-10", intervalDays: 30 } });
    expect((await s.installments(inv.json.id)).map((i: any) => i.amountCents)).toEqual([3333, 3333, 3334]);
    const [i1, i2, i3] = await s.installments(inv.json.id);
    const part = await s.receive(s.c, [{ installmentId: i1.id, principalCents: 1000 }]); expect(part.status, JSON.stringify(part.json)).toBe(201);
    expect((await s.installments(inv.json.id))[0]).toMatchObject({ status: "partial", paidCents: 1000, openCents: 2333 });
    expect((await s.receive(s.c, [{ installmentId: i1.id, principalCents: 2334 }])).json.error).toBe("exceeds_open_amount");
    const multi = await s.receive(s.c, [{ installmentId: i1.id, principalCents: 2333 }, { installmentId: i2.id, principalCents: 3333 }, { installmentId: i3.id, principalCents: 100 }]);
    expect(multi.status).toBe(201);
    expect((await s.installments(inv.json.id)).map((i: any) => i.status)).toEqual(["paid", "paid", "partial"]);
    // cancelar fatura com recebimentos ativos é bloqueado; estorna primeiro
    expect((await s.c.post(`/finance/documents/${inv.json.id}/cancel`, { reason: "erro de lançamento" })).json.error).toBe("has_settlements");
    expect((await s.c.post(`/finance/settlements/${part.json.id}/reverse`, {})).status).toBe(422);
    expect((await s.c.post(`/finance/settlements/${part.json.id}/reverse`, { reason: "recebido por engano" })).status).toBe(200);
    expect((await s.c.post(`/finance/settlements/${part.json.id}/reverse`, { reason: "recebido por engano" })).json.error).toBe("already_reversed");
    expect((await s.installments(inv.json.id))[0].paidCents).toBe(2333);
    expect((await s.c.post(`/finance/settlements/${multi.json.id}/reverse`, { reason: "estorno total" })).status).toBe(200);
    expect((await s.c.post(`/finance/documents/${inv.json.id}/cancel`, { reason: "OS faturada por engano" })).status).toBe(200);
    expect((await s.installments(inv.json.id)).every((i: any) => i.status === "cancelled")).toBe(true);
    expect((await s.receive(s.c, [{ installmentId: i1.id, principalCents: 100 }])).json.error).toBe("document_cancelled");
    expect((await s.invoice(os)).status).toBe(201); // refaturar após cancelar
    expect(await ledgerBalance(s.t.tenantId)).toBe("0");
    const bal = (await s.c.get("/finance/balances")).json; expect(bal.totalCents).toBe(100000); // só a abertura: tudo estornado
  });
  it("juros e multa em atraso (regra v1), com possibilidade de dispensa só para quem tem permissão", async () => {
    const s = await setup(); const os = await s.mkOrder([["Serviço", "service", 10000]]);
    const inv = await s.invoice(os, { plan: { count: 1, firstDueDate: "2026-01-01" } });
    const [i1] = await s.installments(inv.json.id);
    expect(i1.status).toBe("overdue");
    const q = await s.c.get(`/finance/installments/${i1.id}/quote?on=2026-03-02`);
    const exp = lateCharges({ principalCents: 10000, dueDate: "2026-01-01", on: "2026-03-02", fineBp: 200, interestBpMonth: 100 });
    expect(q.json.charges).toMatchObject({ days: exp.days, fineCents: 200, interestCents: exp.interestCents });
    const rc = await s.receive(s.c, [{ installmentId: i1.id, principalCents: 10000 }], { settledOn: "2026-03-02" });
    expect(rc.json.chargesCents).toBe(200 + exp.interestCents);
    const income = await ownerSql<{ n: string }>("select sum(e.amount_cents)::bigint n from ledger_entries e join fin_accounts a on a.id = e.account_id where a.system_key = 'interest_income' and e.tenant_id = $1", [s.t.tenantId]);
    expect(Number(income[0]!.n)).toBe(200 + exp.interestCents);
    const att = await addMember(s.t, "attendant");
    const os2 = await s.mkOrder([["Serviço", "service", 10000]]);
    const inv2 = await s.invoice(os2, { plan: { count: 1, firstDueDate: "2026-01-01" } });
    const [j1] = await s.installments(inv2.json.id);
    expect((await s.receive(att, [{ installmentId: j1.id, principalCents: 10000 }], { waiveCharges: true })).status).toBe(403);
    expect((await s.receive(s.c, [{ installmentId: j1.id, principalCents: 10000 }], { waiveCharges: true })).json.chargesCents).toBe(0);
  });
});

describe("F5 competência × caixa", () => {
  it("divergem corretamente entre meses (despesa competida em jun/2029 e paga hoje; fatura sem recebimento)", async () => {
    const s = await setup();
    const unitId = s.t.unitIds[0];
    const acc = (await s.c.get("/finance/accounts")).json.accounts.find((a: any) => a.system_key === "exp_rent");
    const pay = await s.c.post("/finance/payables", { unitId, partyName: "Imobiliária X", accountId: acc.id, description: "Aluguel jun/29", totalCents: 200000, competenceDate: "2029-06-15", plan: { count: 1, firstDueDate: "2029-07-05" } });
    expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    const [pi] = (await s.c.get("/finance/payables")).json.installments;
    expect((await post(s.c, "/finance/payments", { walletId: s.walletId, method: "transfer", allocations: [{ installmentId: pi.id, principalCents: 200000 }] }, key())).status).toBe(201);
    const os = await s.mkOrder([["Serviço", "service", 30000]]); await s.invoice(os);
    const today = (await ownerSql<{ d: string }>("select (now() at time zone 'America/Sao_Paulo')::date::text d"))[0]!.d; const month = today.slice(0, 7); const last = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).toISOString().slice(0, 10);
    const ac = (await s.c.get(`/finance/dre?from=2029-06-01&to=2029-06-30&basis=accrual`)).json;
    expect(ac.opex).toBe(200000);
    expect((await s.c.get(`/finance/dre?from=2029-06-01&to=2029-06-30&basis=cash`)).json.opex).toBe(0);
    const accNow = (await s.c.get(`/finance/dre?from=${month}-01&to=${last}&basis=accrual`)).json;
    const cashNow = (await s.c.get(`/finance/dre?from=${month}-01&to=${last}&basis=cash`)).json;
    expect(accNow.grossRevenue).toBe(30000); expect(cashNow.grossRevenue).toBe(0); // faturado ≠ recebido
    expect(cashNow.opex).toBe(200000); expect(accNow.opex).toBe(0);
    expect((await s.c.get("/finance/dre?from=2026-11-31&to=2026-12-01")).status).toBe(422);
    expect(accNow.label).toBe("gerencial estimado");
    const dd = await s.c.get("/finance/dashboard"); const d = dd.json; expect(dd.status, JSON.stringify(dd.json)).toBe(200); expect(d.label).toBe("gerencial estimado");
    const cf = (await s.c.get(`/finance/cashflow?from=2029-01-01&to=2030-12-31`)).json.months;
    expect(cf.find((m: any) => m.month === "2030-01").projectedInCents).toBe(30000);
    expect(cf.find((m: any) => m.month === "2029-07")?.projectedOutCents ?? 0).toBe(0); // já paga
  });
});

describe("F7 idempotência e concorrência", () => {
  it("mesma chave = replay; mesma chave com corpo diferente = 409; 5 chamadas simultâneas = 1 recebimento", async () => {
    const s = await setup(); const os = await s.mkOrder([["Serviço", "service", 10000]]);
    const inv = await s.invoice(os); const [i1] = await s.installments(inv.json.id);
    const k = key();
    const a = await s.receive(s.c, [{ installmentId: i1.id, principalCents: 4000 }], {}, k); expect(a.status).toBe(201);
    const b = await s.receive(s.c, [{ installmentId: i1.id, principalCents: 4000 }], {}, k); expect(b.status).toBe(200); expect(b.json).toMatchObject({ replayed: true, id: a.json.id });
    expect((await s.receive(s.c, [{ installmentId: i1.id, principalCents: 100 }], {}, k)).json.error).toBe("idempotency_key_reuse");
    expect((await post(s.c, "/finance/receipts", { walletId: s.walletId, method: "pix", allocations: [{ installmentId: i1.id, principalCents: 1 }] })).json.error).toBe("idempotency_key_required");
    const k2 = key();
    const same = await Promise.all(Array.from({ length: 5 }, () => s.receive(s.c, [{ installmentId: i1.id, principalCents: 1000 }], {}, k2)));
    expect(same.every((r: { status: number }) => r.status === 200 || r.status === 201)).toBe(true);
    expect((await ownerSql("select 1 from fin_settlements where idempotency_key = $1", [k2]))).toHaveLength(1);
    expect((await s.installments(inv.json.id))[0].paidCents).toBe(5000);
  });
  it("2 recebimentos simultâneos na mesma parcela com chaves distintas: nunca excede o saldo; razão balanceada", async () => {
    const s = await setup(); const os = await s.mkOrder([["Serviço", "service", 10000]]);
    const inv = await s.invoice(os); const [i1] = await s.installments(inv.json.id);
    const res = await Promise.all([s.receive(s.c, [{ installmentId: i1.id, principalCents: 6000 }]), s.receive(s.c, [{ installmentId: i1.id, principalCents: 6000 }]), s.receive(s.c, [{ installmentId: i1.id, principalCents: 4000 }])]);
    const ok = res.filter((r: { status: number }) => r.status === 201).length;
    expect(ok).toBeGreaterThanOrEqual(1); expect(ok).toBeLessThanOrEqual(2);
    const row = (await s.installments(inv.json.id))[0];
    expect(row.paidCents).toBeLessThanOrEqual(10000); expect(row.openCents).toBe(10000 - row.paidCents);
    expect(await ledgerBalance(s.t.tenantId)).toBe("0");
  });
});

describe("F8 DRE reconcilia com o ledger", () => {
  it("receita/descontos/custos da DRE de competência = somas diretas do ledger", async () => {
    const s = await setup(); const os = await s.mkOrder([["Serviço", "service", 20000], ["Peça", "part", 8000]]);
    await s.invoice(os, { discountCents: 1000, discountReason: "cliente fiel" });
    const acc = (await s.c.get("/finance/accounts")).json.accounts.find((a: any) => a.system_key === "cost_parts");
    await s.c.post("/finance/payables", { unitId: s.t.unitIds[0], partyName: "Autopeças Z", accountId: acc.id, description: "Peça OS", totalCents: 5000, osId: os, plan: { count: 2, firstDueDate: "2030-02-01" } });
    const dre = (await s.c.get(`/finance/dre?from=2020-01-01&to=2099-12-31&basis=accrual`)).json;
    const sum = async (type: string) => Number((await ownerSql<{ n: string }>(`select coalesce(sum(case when a.type in ('revenue','financial') then (case e.side when 'C' then e.amount_cents else -e.amount_cents end) else (case e.side when 'D' then e.amount_cents else -e.amount_cents end) end),0)::bigint n
      from ledger_entries e join fin_accounts a on a.id = e.account_id where a.type = $1 and e.tenant_id = $2`, [type, s.t.tenantId]))[0]!.n);
    expect(dre.grossRevenue).toBe(await sum("revenue")); expect(dre.deductions).toBe(await sum("deduction")); expect(dre.directCosts).toBe(await sum("direct_cost"));
    expect(dre).toMatchObject({ grossRevenue: 28000, deductions: 1000, netRevenue: 27000, directCosts: 5000, contributionMargin: 22000 });
    // lucro por OS: margem de contribuição × resultado operacional estimado
    await s.c.put("/finance/settings", { overheadMethod: "fixed", overheadValue: 700 });
    const pr = (await s.c.get(`/orders/${os}/profit`)).json;
    expect(pr).toMatchObject({ label: "gerencial estimado", revenueSource: "invoiced", netRevenueCents: 27000, directCostsCents: 5000, contributionMarginCents: 22000, overheadCents: 700, estimatedOperatingResultCents: 21300 });
    expect((await s.c.post(`/orders/${os}/invoice`, { plan: { count: 1, firstDueDate: "2030-01-10" } })).status).toBe(409);
  });
});

describe("F9 alçadas e permissões", () => {
  it("desconto acima da alçada exige override; atendente não vê DRE nem fatura; estorno acima do limite exige override", async () => {
    const s = await setup();
    const mgr = await addMember(s.t, "manager"); const att = await addMember(s.t, "attendant");
    const os = await s.mkOrder([["Serviço", "service", 10000]]);
    expect((await s.invoice(os, { discountCents: 600, discountReason: "negociado" }, mgr)).json.error).toBe("override_required"); // 6% > 5%
    expect((await s.invoice(os, { discountCents: 500 }, mgr)).json.error).toBe("discount_reason_required");
    expect((await s.invoice(os, { discountCents: 600, discountReason: "negociado" }, att)).status).toBe(403);
    const ok = await s.invoice(os, { discountCents: 500, discountReason: "cliente fiel" }, mgr); expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect((await att.get("/finance/dre?from=2030-01-01&to=2030-12-31")).status).toBe(403);
    expect((await att.get("/finance/dashboard")).status).toBe(403);
    expect((await att.get(`/orders/${os}/profit`)).status).toBe(403);
    expect((await att.get("/finance/wallets")).json.wallets[0].balanceCents).toBeUndefined(); // atendente não vê saldo
    expect((await s.c.put("/finance/settings", { reversalLimitCents: 100 })).status).toBe(200);
    expect((await mgr.put("/finance/settings", { reversalLimitCents: 1 })).status).toBe(403);
    const [i1] = await s.installments(ok.json.id);
    const rc = await s.receive(mgr, [{ installmentId: i1.id, principalCents: 9500 }]); expect(rc.status).toBe(201);
    expect((await mgr.post(`/finance/settlements/${rc.json.id}/reverse`, { reason: "valor errado" })).json.error).toBe("override_required");
    expect((await s.c.post(`/finance/settlements/${rc.json.id}/reverse`, { reason: "valor errado" })).status).toBe(200);
  });
  it("isolamento: outro tenant não vê nem recebe documentos alheios", async () => {
    const A = await setup(); const B = await setup();
    const os = await A.mkOrder([["Serviço", "service", 10000]]); const inv = await A.invoice(os); const [i1] = await A.installments(inv.json.id);
    expect((await B.c.get("/finance/receivables")).json.installments).toHaveLength(0);
    expect((await B.receive(B.c, [{ installmentId: i1.id, principalCents: 100 }])).status).toBe(404);
    expect((await B.c.get(`/orders/${os}/profit`)).status).toBe(404);
  });
});

describe("Conciliação básica e transferências", () => {
  it("importa extrato, sugere lançamento por valor/data, concilia uma vez e rejeita divergência; transferência entre carteiras", async () => {
    const s = await setup(); const os = await s.mkOrder([["Serviço", "service", 10000]]);
    const inv = await s.invoice(os); const [i1] = await s.installments(inv.json.id);
    await s.receive(s.c, [{ installmentId: i1.id, principalCents: 10000 }]);
    const today = (await ownerSql<{ d: string }>("select (now() at time zone 'America/Sao_Paulo')::date::text d"))[0]!.d;
    const imp = await s.c.post(`/finance/wallets/${s.walletId}/statement`, { lines: [{ date: today, description: "PIX recebido", amountCents: 10000, externalRef: "E1" }, { date: today, description: "Tarifa", amountCents: -990, externalRef: "E2" }] });
    expect(imp.json.imported).toBe(2);
    expect((await s.c.post(`/finance/wallets/${s.walletId}/statement`, { lines: [{ date: today, description: "PIX recebido", amountCents: 10000, externalRef: "E1" }] })).json.imported).toBe(0);
    const rec = (await s.c.get(`/finance/wallets/${s.walletId}/reconciliation`)).json.unmatched;
    const pix = rec.find((l: any) => l.amountCents === 10000); expect(pix.suggestions.length).toBeGreaterThan(0);
    expect(rec.find((l: any) => l.amountCents === -990).suggestions).toHaveLength(0);
    expect((await s.c.post("/finance/reconciliation/match", { lineId: pix.lineId, entryId: pix.suggestions[0].entryId })).status).toBe(200);
    expect((await s.c.post("/finance/reconciliation/match", { lineId: pix.lineId, entryId: pix.suggestions[0].entryId })).json.error).toBe("already_matched");
    const tar = rec.find((l: any) => l.amountCents === -990);
    expect((await s.c.post("/finance/reconciliation/match", { lineId: tar.lineId, entryId: pix.suggestions[0].entryId })).json.error).toBe("amount_mismatch");
    const w2 = await s.c.post("/finance/wallets", { name: "Banco", kind: "bank" });
    expect((await s.c.post("/finance/transfers", { fromWalletId: s.walletId, toWalletId: w2.json.id, amountCents: 5000 })).status).toBe(201);
    const bal = (await s.c.get("/finance/balances")).json; expect(bal.wallets.find((w: any) => w.id === w2.json.id).balanceCents).toBe(5000); expect(bal.totalCents).toBe(110000);
    expect(await ledgerBalance(s.t.tenantId)).toBe("0");
  });
});
