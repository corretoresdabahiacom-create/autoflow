import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processOutbox } from "../src/outbox";
import { runAutomations } from "../src/routes/advanced";
import { hashPassword } from "../src/password";
import { Client, type Harness, type SeededTenant, PW, freshCode, loginOwner, makeHarness, ownerSql, seedPlatformUser, seedTenant, uniq } from "./harness";

let h: Harness;
beforeAll(() => { h = makeHarness(); });
afterAll(async () => { await ownerSql("delete from platform_settings where key = 'automation_kill_switch'"); await h.db.close(); });

let ipn = 1;
const nextIp = () => `10.99.${Math.floor(ipn / 250)}.${(ipn++ % 250) + 1}`;
const PLATE = () => `PTK${Math.floor(Math.random() * 9)}${"ABCDEFGHJK"[Math.floor(Math.random() * 10)]}${Math.floor(Math.random() * 90 + 10)}`;
const ok = (r: { status: number; json: any }, code = 200) => { expect(r.status, JSON.stringify(r.json)).toBe(code); return r.json; };
const iso = (ms: number) => new Date(ms).toISOString();

async function addMember(t: SeededTenant, role: string, units: "all" | string[] = "all") {
  const email = `${uniq("m")}@example.test`;
  const u = await ownerSql<{ id: string }>("insert into users (email, password_hash) values ($1,$2) returning id", [email, await hashPassword(PW, 10)]);
  const r = await ownerSql<{ id: string }>("select id from roles where tenant_id is null and key = $1", [role]);
  const m = await ownerSql<{ id: string }>("insert into memberships (tenant_id, user_id, role_id, status, all_units) values ($1,$2,$3,'active',$4) returning id", [t.tenantId, u[0]!.id, r[0]!.id, units === "all"]);
  if (units !== "all") for (const uid of units) await ownerSql("insert into unit_memberships (tenant_id, membership_id, unit_id) values ($1,$2,$3)", [t.tenantId, m[0]!.id, uid]);
  const cl = new Client(h, nextIp()); ok(await cl.post("/auth/login", { email, password: PW, tenantSlug: t.slug }));
  return { cl, membershipId: m[0]!.id };
}
async function setup(opts: { plan?: string } = {}) {
  const t = await seedTenant(h, opts); const c = await loginOwner(h, t, nextIp());
  const cu = ok(await c.post("/customers", { name: "Maria Silva", phone: "(71) 99999-1234", email: "maria@example.test" }), 201).id as string;
  const ve = ok(await c.post(`/customers/${cu}/vehicles`, { plate: PLATE(), make: "VW" }), 201).id as string;
  const wallet = ok(await c.post("/finance/wallets", { name: "Conta", kind: "bank", openingBalanceCents: 0 }), 201).id as string;
  /** OS aprovada → (tarefa do mecânico concluída) → entregue → faturada à vista. */
  const deliver = async (amount: number, o: { unitId?: string; mech?: { cl: Client; membershipId: string } } = {}) => {
    const os = ok(await c.post("/orders", { customerId: cu, vehicleId: ve, unitId: o.unitId }), 201).id as string;
    if (o.mech) {
      const tk = ok(await c.post(`/orders/${os}/tasks`, { title: "Serviço", assigneeMembershipId: o.mech.membershipId }), 201).id;
      ok(await o.mech.cl.post(`/production/tasks/${tk}/start`)); ok(await o.mech.cl.post(`/production/tasks/${tk}/complete`));
    }
    await c.post(`/orders/${os}/estimate/items`, { description: "Serviço", category: "service", qty: 1, unitPriceCents: amount });
    await c.post(`/orders/${os}/estimate/publish`);
    const est = (await c.get(`/orders/${os}/estimate`)).json.versions.find((v: any) => v.status === "published");
    await c.post(`/orders/${os}/estimate/decisions`, { customerName: "Maria", decisions: est.items.map((i: any) => ({ itemId: i.id, decision: "approved" })) });
    ok(await c.patch(`/orders/${os}`, { status: "delivered" }));
    const inv = ok(await c.post(`/orders/${os}/invoice`, { plan: { count: 1, firstDueDate: "2030-01-10" } }), 201);
    return { os, docId: inv.id as string };
  };
  const openOrder = async (unitId?: string) => ok(await c.post("/orders", { customerId: cu, vehicleId: ve, unitId }), 201).id as string;
  return { t, c, cu, ve, wallet, deliver, openOrder };
}
const today = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const range = () => `from=2020-01-01&to=2099-12-31`;

describe("E1 entitlements premium aplicados no backend", () => {
  it("rotas Premium exigem o recurso do plano (e a permissão); override e suspensão valem", async () => {
    const ess = await setup({ plan: "ESSENCIAL" });
    for (const p of ["/insurers", "/claims", `/reports/consolidated?${range()}`, "/automation/rules", "/agenda/waitlist", "/commissions/rules"])
      expect((await ess.c.get(p)).json.error, p).toBe("feature_not_in_plan");
    const pro = await setup({ plan: "PROFISSIONAL" });
    expect((await pro.c.get("/agenda/waitlist")).status).toBe(200); expect((await pro.c.get("/commissions/rules")).status).toBe(200); // agenda/team no plano
    for (const p of ["/insurers", `/reports/consolidated?${range()}`, "/automation/rules"]) expect((await pro.c.get(p)).json.error, p).toBe("feature_not_in_plan");
    await ownerSql("insert into tenant_feature_overrides (tenant_id, feature_code, value, reason) values ($1,'insurers','true','teste')", [pro.t.tenantId]);
    expect((await pro.c.get("/insurers")).status).toBe(200); // override do Super Admin vence o plano
    const prem = await setup();
    for (const p of ["/insurers", `/reports/consolidated?${range()}`, "/automation/rules", "/agenda/waitlist", "/commissions/rules"]) expect((await prem.c.get(p)).status, p).toBe(200);
    const mech = await addMember(prem.t, "mechanic");
    expect((await mech.cl.get("/insurers")).json.error).toBe("permission_denied");
    expect((await mech.cl.get(`/reports/consolidated?${range()}`)).json.error).toBe("permission_denied");
    await ownerSql("update subscriptions set status = 'suspended' where tenant_id = $1", [prem.t.tenantId]);
    expect((await prem.c.get("/insurers")).status).toBeGreaterThanOrEqual(402); // suspensa: nada de recursos
  });
});

describe("I1 seguradoras: sinistro, autorizações versionadas e prazos", () => {
  it("fluxo completo, transições inválidas, histórico imutável e prazo vencido", async () => {
    const s = await setup(); const os = await s.openOrder();
    const ins = ok(await s.c.post("/insurers", { name: "Seguradora Alfa", slaAuthorizationHours: 24 }), 201).id;
    expect((await s.c.post("/insurers", { name: "Seguradora Alfa" })).status).toBe(409);
    const k = ok(await s.c.post(`/orders/${os}/claims`, { insurerId: ins, claimNo: "SIN-001", deductibleCents: 3000 }), 201).id;
    expect((await s.c.post(`/orders/${os}/claims`, { insurerId: ins, claimNo: "SIN-001" })).status).toBe(409);
    expect((await s.c.post(`/claims/${k}/authorization`, { authorizedCents: 100 })).json.error).toBe("not_awaiting_authorization");
    const before = Date.now();
    const rq = ok(await s.c.post(`/claims/${k}/request-authorization`, { requestedCents: 10000 }));
    const due = new Date(rq.authorizationDueAt).getTime(); expect(due - before).toBeGreaterThan(23.9 * 3600_000); expect(due - before).toBeLessThan(24.1 * 3600_000);
    expect((await s.c.post(`/claims/${k}/authorization`, { authorizedCents: 10001 })).status).toBe(422);
    const a1 = ok(await s.c.post(`/claims/${k}/authorization`, { authorizedCents: 7000, code: "AUT-9" })); expect(a1).toMatchObject({ status: "partially_authorized", decision: "partial", version: 1 });
    const d1 = ok(await s.c.get(`/claims/${k}`)).claim; expect(d1).toMatchObject({ authorizedCents: 7000, insurerCents: 4000, customerCents: 3000, deadline: "none" });
    expect((await s.c.post(`/claims/${k}/request-authorization`, { requestedCents: 6000 })).json.error).toBe("requested_below_authorized"); // complemento nunca abaixo do autorizado
    ok(await s.c.post(`/claims/${k}/request-authorization`, { requestedCents: 9000 }));
    expect(ok(await s.c.post(`/claims/${k}/authorization`, { authorizedCents: 9000 })).decision).toBe("authorized");
    const det = ok(await s.c.get(`/claims/${k}`)); expect(det.authorizations.map((a: any) => [a.version_no, a.decision])).toEqual([[1, "partial"], [2, "authorized"]]);
    expect((await s.c.post(`/claims/${k}/status`, { to: "paid" })).json.error).toBe("invalid_transition"); // não paga antes de concluir
    ok(await s.c.post(`/claims/${k}/status`, { to: "completed" })); ok(await s.c.post(`/claims/${k}/status`, { to: "paid" }));
    expect((await s.c.post(`/claims/${k}/status`, { to: "cancelled", reason: "teste" })).json.error).toBe("invalid_transition");
    await expect(ownerSql("update claim_authorizations set authorized_cents = 1 where claim_id = $1", [k])).rejects.toThrow(); // append-only
    // prazo vencido
    const os2 = await s.openOrder(); const k2 = ok(await s.c.post(`/orders/${os2}/claims`, { insurerId: ins, claimNo: "SIN-002" }), 201).id;
    ok(await s.c.post(`/claims/${k2}/request-authorization`, { requestedCents: 5000 }));
    expect(ok(await s.c.get("/claims?deadline=ok")).claims.map((x: any) => x.id)).toContain(k2);
    await ownerSql("update insurance_claims set authorization_due_at = now() + interval '6 hours' where id = $1", [k2]);
    expect(ok(await s.c.get("/claims?deadline=due_soon")).claims.map((x: any) => x.id)).toEqual([k2]);
    await ownerSql("update insurance_claims set authorization_due_at = now() - interval '1 hour' where id = $1", [k2]);
    expect(ok(await s.c.get("/claims?deadline=overdue")).claims.map((x: any) => x.id)).toEqual([k2]);
    expect((await s.c.post(`/claims/${k2}/status`, { to: "cancelled" })).status).toBe(422); // motivo obrigatório
    ok(await s.c.post(`/claims/${k2}/status`, { to: "cancelled", reason: "segurado desistiu" }));
    expect(ok(await s.c.get("/claims?deadline=overdue")).claims).toEqual([]);
    expect((await ownerSql("select count(*)::int n from audit_log where tenant_id = $1 and action like 'claim.%'", [s.t.tenantId]))[0].n).toBeGreaterThanOrEqual(8);
  });
});

describe("U1 multiunidade: transferência, consolidado por escopo e conciliação com o estoque", () => {
  it("transferência no custo médio, idempotente, ledger por unidade; consolidado respeita o escopo", async () => {
    const s = await setup(); const [u0, u1] = s.t.unitIds as [string, string];
    const item = ok(await s.c.post("/stock/items", { sku: "TRF1", name: "Filtro", category: "part" }), 201).id;
    ok(await s.c.post("/stock/purchases", { unitId: u0, items: [{ itemId: item, qty: 10, totalCents: 10000 }] }), 201);
    const key = `trf-${uniq("k")}`;
    const t1 = ok(await s.c.post("/stock/transfers", { fromUnitId: u0, toUnitId: u1, idempotencyKey: key, items: [{ itemId: item, qty: 4 }] }), 201); expect(t1.totalCents).toBe(4000);
    expect(ok(await s.c.post("/stock/transfers", { fromUnitId: u0, toUnitId: u1, idempotencyKey: key, items: [{ itemId: item, qty: 4 }] })).replayed).toBe(true);
    const lv = await ownerSql<any>("select unit_id, on_hand_milli, value_cents from stock_levels where item_id = $1", [item]);
    expect(lv.find((l: any) => l.unit_id === u0)).toMatchObject({ on_hand_milli: "6000", value_cents: "6000" }); expect(lv.find((l: any) => l.unit_id === u1)).toMatchObject({ on_hand_milli: "4000", value_cents: "4000" });
    expect((await s.c.post("/stock/transfers", { fromUnitId: u0, toUnitId: u1, idempotencyKey: `x-${uniq("k")}`, items: [{ itemId: item, qty: 7 }] })).json.error).toBe("insufficient_stock");
    expect((await s.c.post("/stock/transfers", { fromUnitId: u0, toUnitId: u0, idempotencyKey: `y-${uniq("k")}`, items: [{ itemId: item, qty: 1 }] })).status).toBe(422);
    // conta de transferência entre unidades líquida zero; estoque × ledger por unidade reconciliam
    const clr = await ownerSql<any>("select coalesce(sum(case e.side when 'D' then e.amount_cents else -e.amount_cents end),0)::int b from ledger_entries e join fin_accounts a on a.id = e.account_id where a.tenant_id = $1 and a.system_key = 'inter_unit'", [s.t.tenantId]); expect(clr[0].b).toBe(0);
    const sv = ok(await s.c.get("/reports/stock-valuation")); expect(sv.totalDiffCents).toBe(0); expect(sv.units.find((u: any) => u.unitId === u1)).toMatchObject({ stockValueCents: 4000, ledgerInventoryCents: 4000 });
    // faturamento em cada unidade; usuário com escopo só na unidade 0 enxerga só ela
    await s.deliver(30000, { unitId: u0 }); await s.deliver(50000, { unitId: u1 });
    const mgr0 = await addMember(s.t, "manager", [u0]);
    const all = ok(await s.c.get(`/reports/consolidated?${range()}`)); expect(all.units).toHaveLength(2);
    expect(all.total.dre.grossRevenue).toBe(80000); expect(all.units.map((u: any) => u.dre.grossRevenue).sort()).toEqual([30000, 50000]);
    const mine = ok(await mgr0.cl.get(`/reports/consolidated?${range()}`)); expect(mine.scope).toBe("list"); expect(mine.units.map((u: any) => u.unitId)).toEqual([u0]);
    expect(mine.total.dre.grossRevenue).toBe(30000); expect(mine.total.stockValueCents).toBe(6000);
    // o escopo também vale para transferência
    const sk = await addMember(s.t, "stockkeeper", [u0]);
    expect((await sk.cl.post("/stock/transfers", { fromUnitId: u0, toUnitId: u1, idempotencyKey: `z-${uniq("k")}`, items: [{ itemId: item, qty: 1 }] })).json.error).toBe("unit_not_allowed");
  });
});

describe("R1 relatórios reconciliam com ledger/estoque/tempo", () => {
  it("DRE por categoria/unidade, lucro por OS e produtividade batem com o ledger", async () => {
    const s = await setup(); const [u0] = s.t.unitIds as [string, string];
    const mech = await addMember(s.t, "mechanic"); ok(await s.c.put(`/production/employees/${mech.membershipId}/rate`, { hourlyCostCents: 6000 }));
    const item = ok(await s.c.post("/stock/items", { sku: "RC1", name: "Pastilha", category: "part" }), 201).id;
    ok(await s.c.post("/stock/purchases", { unitId: u0, items: [{ itemId: item, qty: 5, totalCents: 5000 }] }), 201);
    const os = ok(await s.c.post("/orders", { customerId: s.cu, vehicleId: s.ve, unitId: u0 }), 201).id;
    ok(await s.c.post(`/orders/${os}/stock/consume`, { itemId: item, qty: 2 }), 201);
    const tk = ok(await s.c.post(`/orders/${os}/tasks`, { title: "Freios", assigneeMembershipId: mech.membershipId, dueAt: iso(Date.now() + 86400_000) }), 201).id;
    ok(await mech.cl.post(`/production/tasks/${tk}/start`));
    await ownerSql("update task_time_entries set started_at = now() - interval '90 minutes' where task_id = $1", [tk]);
    ok(await mech.cl.post(`/production/tasks/${tk}/complete`));
    await s.c.post(`/orders/${os}/estimate/items`, { description: "Freios", category: "service", qty: 1, unitPriceCents: 40000 }); await s.c.post(`/orders/${os}/estimate/publish`);
    const est = (await s.c.get(`/orders/${os}/estimate`)).json.versions.find((v: any) => v.status === "published");
    await s.c.post(`/orders/${os}/estimate/decisions`, { customerName: "Maria", decisions: est.items.map((i: any) => ({ itemId: i.id, decision: "approved" })) });
    ok(await s.c.patch(`/orders/${os}`, { status: "delivered" })); ok(await s.c.post(`/orders/${os}/invoice`, { plan: { count: 1, firstDueDate: "2030-01-10" } }), 201);
    await s.deliver(10000, { unitId: u0 }); // OS adicional sem custo
    const q = range();
    const dre = ok(await s.c.get(`/finance/dre?${q}&basis=accrual`));
    const cat = ok(await s.c.get(`/reports/result-by-category?${q}`));
    expect(cat.dre).toMatchObject({ grossRevenue: dre.grossRevenue, directCosts: dre.directCosts, opex: dre.opex, operatingResult: dre.operatingResult });
    expect(cat.byType.find((t: any) => t.type === "revenue").totalCents).toBe(50000);
    expect(cat.byType.find((t: any) => t.type === "direct_cost").totalCents).toBe(2000); // 2 un × R$ 10,00 (custo médio)
    expect(ok(await s.c.get(`/reports/consolidated?${q}`)).total.dre.operatingResult).toBe(dre.operatingResult);
    const pf = ok(await s.c.get(`/reports/profit-by-order?${q}`));
    const row = pf.orders.find((o: any) => o.osId === os); expect(row).toMatchObject({ netRevenueCents: 40000, directCostsCents: 2000, contributionMarginCents: 38000 });
    expect(row.trackedMinutes).toBeGreaterThanOrEqual(89); expect(row.laborCostCents).toBeGreaterThanOrEqual(8900); expect(row.marginAfterLaborCents).toBe(38000 - row.laborCostCents);
    for (const k of ["revenue", "directCosts"] as const) expect(pf.reconciliation[k].byOrdersCents + pf.reconciliation[k].withoutOrderCents, k).toBe(pf.reconciliation[k].ledgerTotalCents);
    expect(pf.reconciliation.revenue.ledgerTotalCents).toBe(dre.grossRevenue); expect(pf.reconciliation.directCosts.ledgerTotalCents).toBe(dre.directCosts);
    const pr = ok(await s.c.get(`/reports/productivity?from=${today()}&to=${today()}`)); const me = pr.people.find((x: any) => x.membershipId === mech.membershipId);
    expect(me.tasksDone).toBe(1); expect(me.tasksOnTime).toBe(1); expect(me.trackedMinutes).toBeGreaterThanOrEqual(89); expect(me.laborCostCents).toBe(row.laborCostCents);
    expect(pr.totals.trackedMinutes).toBe(me.trackedMinutes);
    expect(ok(await s.c.get(`/reports/stock-valuation`)).totalDiffCents).toBe(0); // consumo posterior também reconcilia
  });
});

describe("C1 comissões: regra versionada, histórico imutável, adiantamentos", () => {
  it("calcula pela regra vigente na entrega, não reescreve histórico, ajusta por delta e abate adiantamento", async () => {
    const s = await setup(); const mech = await addMember(s.t, "mechanic");
    const r1 = ok(await s.c.post("/commissions/rules", { membershipId: mech.membershipId, basis: "os_net_revenue", rateBps: 500, validFrom: iso(Date.now() - 86400_000) }), 201); expect(r1.versionNo).toBe(1);
    const a = await s.deliver(30000, { mech }); const key = `cmp-${uniq("k")}`;
    const c1 = ok(await s.c.post(`/orders/${a.os}/commissions/calculate`)); expect(c1.results).toEqual([{ membershipId: mech.membershipId, status: "accrued", amountCents: 1500 }]);
    expect(ok(await s.c.post(`/orders/${a.os}/commissions/calculate`)).results[0].status).toBe("unchanged"); // idempotente
    // nova versão da regra (10%) vale só para entregas futuras; a OS antiga mantém 5%
    expect(ok(await s.c.post("/commissions/rules", { membershipId: mech.membershipId, basis: "os_net_revenue", rateBps: 1000 }), 201).versionNo).toBe(2);
    expect(ok(await s.c.post(`/orders/${a.os}/commissions/calculate`)).results[0]).toMatchObject({ status: "unchanged", amountCents: 1500 });
    const b = await s.deliver(30000, { mech });
    expect(ok(await s.c.post(`/orders/${b.os}/commissions/calculate`)).results[0]).toMatchObject({ status: "accrued", amountCents: 3000 });
    await expect(ownerSql("update commission_rules set rate_bps = 1 where tenant_id = $1", [s.t.tenantId])).rejects.toThrow();
    await expect(ownerSql("delete from commission_entries where tenant_id = $1", [s.t.tenantId])).rejects.toThrow();
    // sem regra / sem participação
    const other = await addMember(s.t, "mechanic"); const cOs = await s.deliver(10000, { mech: other });
    expect(ok(await s.c.post(`/orders/${cOs.os}/commissions/calculate`)).results[0].status).toBe("no_rule");
    expect((await s.c.post(`/orders/${await s.openOrder()}/commissions/calculate`)).json.error).toBe("order_not_delivered");
    // cancelar a fatura da OS A → ajuste negativo (nunca edita o lançamento original)
    ok(await s.c.post(`/finance/documents/${a.docId}/cancel`, { reason: "erro de lançamento" }));
    expect(ok(await s.c.post(`/orders/${a.os}/commissions/calculate`)).results[0]).toMatchObject({ status: "adjusted", adjustmentCents: -1500 });
    const bal = ok(await s.c.get(`/commissions/balance?membershipId=${mech.membershipId}`)); expect(bal).toMatchObject({ accruedCents: 3000, payableCents: 3000, outstandingAdvancesCents: 0 });
    const es = ok(await s.c.get(`/commissions/entries?membershipId=${mech.membershipId}`)).entries; expect(es.map((e: any) => e.kind).sort()).toEqual(["accrual", "accrual", "adjustment"]);
    // adiantamento idempotente e abatido no pagamento
    const adv = ok(await s.c.post("/commissions/advances", { membershipId: mech.membershipId, walletId: s.wallet, amountCents: 1000, idempotencyKey: key }), 201);
    expect(ok(await s.c.post("/commissions/advances", { membershipId: mech.membershipId, walletId: s.wallet, amountCents: 1000, idempotencyKey: key })).id).toBe(adv.id);
    expect((await s.c.post("/commissions/advances", { membershipId: mech.membershipId, walletId: s.wallet, amountCents: 999, idempotencyKey: key })).json.error).toBe("idempotency_key_reused");
    expect(ok(await s.c.get(`/commissions/balance?membershipId=${mech.membershipId}`)).outstandingAdvancesCents).toBe(1000);
    const pk = `pay-${uniq("k")}`;
    expect((await s.c.post("/commissions/payouts", { membershipId: mech.membershipId, walletId: s.wallet, grossCents: 3001, idempotencyKey: pk })).json.error).toBe("exceeds_payable");
    const po = ok(await s.c.post("/commissions/payouts", { membershipId: mech.membershipId, walletId: s.wallet, idempotencyKey: pk }), 201); expect(po).toMatchObject({ grossCents: 3000, advanceOffsetCents: 1000, netCents: 2000 });
    expect(ok(await s.c.post("/commissions/payouts", { membershipId: mech.membershipId, walletId: s.wallet, idempotencyKey: pk })).replayed).toBe(true);
    expect((await s.c.post("/commissions/payouts", { membershipId: mech.membershipId, walletId: s.wallet, idempotencyKey: `n-${uniq("k")}` })).json.error).toBe("nothing_to_pay");
    expect(ok(await s.c.get(`/commissions/balance?membershipId=${mech.membershipId}`))).toMatchObject({ payableCents: 0, outstandingAdvancesCents: 0 });
    // ledger: Comissões a pagar e Adiantamentos zerados; carteira saiu 1000 + 2000; todas as txns balanceadas
    const bals = await ownerSql<any>(`select a.system_key k, sum(case e.side when 'D' then e.amount_cents else -e.amount_cents end)::int b from ledger_entries e join fin_accounts a on a.id = e.account_id where a.tenant_id = $1 and a.system_key in ('commissions_payable','employee_advances','exp_commissions') group by 1`, [s.t.tenantId]);
    expect(Object.fromEntries(bals.map((x: any) => [x.k, x.b]))).toEqual({ commissions_payable: 0, employee_advances: 0, exp_commissions: 3000 });
    // permissão: o mecânico não vê nem paga comissões
    expect((await mech.cl.get(`/commissions/balance?membershipId=${mech.membershipId}`)).json.error).toBe("permission_denied");
  });
});

describe("A1 agenda avançada: conflitos e lista de espera", () => {
  it("detecta conflito de box/profissional, sugere horário livre e encaixa a fila por prioridade", async () => {
    const s = await setup(); const [u0] = s.t.unitIds as [string, string];
    const box = ok(await s.c.post("/production/boxes", { name: "Box 1", unitId: u0 }), 201).id;
    const t0 = Math.ceil((Date.now() + 86400_000) / 3600_000) * 3600_000; const H = 3600_000;
    ok(await s.c.post("/appointments", { unitId: u0, title: "Revisão", startsAt: iso(t0), endsAt: iso(t0 + 2 * H), boxId: box }), 201);
    const cf = ok(await s.c.get(`/agenda/conflicts?startsAt=${iso(t0 + H)}&endsAt=${iso(t0 + 3 * H)}&boxId=${box}`)); expect(cf.conflict).toBe(true); expect(cf.conflicts[0].kind).toBe("appointment");
    expect(ok(await s.c.get(`/agenda/conflicts?startsAt=${iso(t0 + 2 * H)}&endsAt=${iso(t0 + 3 * H)}&boxId=${box}`)).conflict).toBe(false);
    expect(ok(await s.c.get(`/agenda/free-slot?boxId=${box}&from=${iso(t0)}&to=${iso(t0 + 6 * H)}&durationMinutes=60`)).startsAt).toBe(iso(t0 + 2 * H));
    const lo = ok(await s.c.post("/agenda/waitlist", { customerId: s.cu, title: "Alinhamento", durationMinutes: 60, windowFrom: iso(t0), windowTo: iso(t0 + 8 * H), priority: 1 }), 201).id;
    const hi = ok(await s.c.post("/agenda/waitlist", { customerId: s.cu, title: "Freios", durationMinutes: 60, windowFrom: iso(t0), windowTo: iso(t0 + 8 * H), priority: 5 }), 201).id;
    const tooLong = ok(await s.c.post("/agenda/waitlist", { customerId: s.cu, title: "Pintura", durationMinutes: 300, windowFrom: iso(t0), windowTo: iso(t0 + 8 * H), priority: 9 }), 201).id;
    expect((await s.c.post("/agenda/waitlist", { customerId: s.cu, title: "X", durationMinutes: 60, windowFrom: iso(t0 + H), windowTo: iso(t0) })).status).toBe(422);
    const m = ok(await s.c.get(`/agenda/waitlist/matches?startsAt=${iso(t0 + 2 * H)}&endsAt=${iso(t0 + 4 * H)}`)).matches.map((e: any) => e.id);
    expect(m).toEqual([hi, lo]); expect(m).not.toContain(tooLong); // ordem de prioridade; a de 5h não cabe
    expect((await s.c.post(`/agenda/waitlist/${hi}/schedule`, { boxId: box, startsAt: iso(t0 + H) })).json.error).toBe("slot_conflict");
    ok(await s.c.post(`/agenda/waitlist/${hi}/schedule`, { boxId: box, startsAt: iso(t0 + 2 * H) }), 201);
    expect((await s.c.post(`/agenda/waitlist/${hi}/schedule`, { boxId: box, startsAt: iso(t0 + 4 * H) })).json.error).toBe("not_waiting");
    expect((await s.c.post(`/agenda/waitlist/${lo}/schedule`, { boxId: box, startsAt: iso(t0 + 2 * H) })).json.error).toBe("slot_conflict"); // horário já ocupado pelo encaixe
    expect((await s.c.post(`/agenda/waitlist/${lo}/schedule`, { boxId: box, startsAt: iso(t0 + 20 * H) })).status).toBe(422); // fora da janela
    ok(await s.c.post(`/agenda/waitlist/${lo}/cancel`)); expect(ok(await s.c.get("/agenda/waitlist")).entries.map((e: any) => e.id)).toEqual([tooLong]);
  });
});

describe("M1 automações: idempotência, auditoria, limite de uso e kill-switch", () => {
  it("regra dispara uma vez por evento; limite/kill-switch/tenant bloqueiam sem consumir o evento; auditado", async () => {
    const s = await setup();
    expect((await s.c.post("/automation/rules", { name: "Ruim", triggerKind: "order.delivered", action: "internal_note", config: { text: "{{senha}}" } })).json.error).toBe("variable_not_allowed");
    expect((await s.c.post("/automation/rules", { name: "Loop", triggerKind: "automation.note", action: "internal_note", config: { text: "x" } })).status).toBe(422);
    const rule = ok(await s.c.post("/automation/rules", { name: "Nota na entrega", triggerKind: "order.delivered", action: "internal_note", config: { text: "Entregue: {{plate}} para {{customer_first_name}}" } }), 201).id;
    await s.deliver(10000); // evento ANTES da ativação (regra desativada por padrão)
    ok(await s.c.patch(`/automation/rules/${rule}`, { enabled: true }));
    const dl = await s.deliver(10000); // evento depois da ativação
    const r1 = ok(await s.c.post("/automation/run")); expect(r1).toMatchObject({ done: 1, skipped: 0, failed: 0 });
    const notes = await ownerSql<any>("select title, visible_to_customer from os_timeline where os_id = $1 and kind = 'automation.note'", [dl.os]);
    expect(notes).toHaveLength(1); expect(notes[0].visible_to_customer).toBe(false); expect(notes[0].title).toMatch(/^Entregue: [A-Z0-9]{7} para Maria$/);
    expect(ok(await s.c.post("/automation/run")).done).toBe(0); // idempotente: mesmo evento nunca roda de novo
    expect((await ownerSql("select count(*)::int n from automation_runs where rule_id = $1", [rule]))[0].n).toBe(1);
    expect((await ownerSql("select count(*)::int n from audit_log where tenant_id = $1 and action = 'automation.run'", [s.t.tenantId]))[0].n).toBe(1);
    await expect(ownerSql("delete from automation_runs where rule_id = $1", [rule])).rejects.toThrow();
    // limite mensal do plano (override do Super Admin = 1): o 2º evento fica BLOQUEADO e continua pendente
    await ownerSql("insert into tenant_feature_overrides (tenant_id, feature_code, value, reason) values ($1,'automation.monthly','1','teste')", [s.t.tenantId]);
    const e2 = await s.deliver(10000); const rb = ok(await s.c.post("/automation/run")); expect(rb.done).toBe(0); expect(rb.blocked.limit_reached).toBeGreaterThanOrEqual(1);
    expect((await ownerSql("select count(*)::int n from os_timeline where os_id = $1 and kind = 'automation.note'", [e2.os]))[0].n).toBe(0);
    ok(await s.c.get("/automation/settings")).usedThisMonth === 1 || expect.fail("uso do mês");
    await ownerSql("update tenant_feature_overrides set value = '10' where tenant_id = $1 and feature_code = 'automation.monthly'", [s.t.tenantId]);
    // desligado pelo tenant: nada roda; religado: o evento pendente é processado (não foi consumido)
    ok(await s.c.put("/automation/settings", { enabled: false })); const rt = ok(await s.c.post("/automation/run")); expect(rt.done).toBe(0); expect(rt.blocked.tenant_disabled).toBe(1);
    ok(await s.c.put("/automation/settings", { enabled: true }));
    // kill-switch global (Super Admin, com motivo e auditoria)
    const sa = await seedPlatformUser(h); const pc = new Client(h, nextIp()); ok(await pc.post("/platform/auth/login", { email: sa.email, password: PW })); ok(await pc.post("/platform/auth/mfa/verify", { code: await freshCode("platform_users", sa.id, sa.secret) }));
    expect((await pc.put("/platform/automation/kill-switch", { on: true })).status).toBe(422);
    ok(await pc.put("/platform/automation/kill-switch", { on: true, reason: "incidente simulado" }));
    const rk = ok(await s.c.post("/automation/run")); expect(rk.done).toBe(0); expect(rk.blocked.platform_kill_switch).toBe(1);
    expect(ok(await s.c.get("/automation/settings")).platformKillSwitch).toBe(true);
    ok(await pc.put("/platform/automation/kill-switch", { on: false, reason: "normalizado" }));
    expect((await s.c.put("/platform/automation/kill-switch", { on: true, reason: "tenant não pode" })).status).toBe(401);
    expect(ok(await s.c.post("/automation/run")).done).toBe(1); // e2 finalmente processado, uma única vez
    expect((await ownerSql("select count(*)::int n from audit_log where action = 'automation.kill_switch'"))[0].n).toBeGreaterThanOrEqual(2);
  });
  it("WhatsApp por automação: somente utilidade via outbox; sem conexão => skipped; plano sem o recurso => bloqueado", async () => {
    const s = await setup(); const phone = String(Math.floor(Math.random() * 9e12 + 1e12));
    const rule = ok(await s.c.post("/automation/rules", { name: "Aviso", triggerKind: "order.delivered", action: "whatsapp_template", config: { template: "os_entregue", params: ["{{customer_first_name}}", "{{os_number}}"] } }), 201).id;
    ok(await s.c.patch(`/automation/rules/${rule}`, { enabled: true }));
    await s.deliver(10000); expect(ok(await s.c.post("/automation/run"))).toMatchObject({ done: 0, skipped: 1 });
    expect((await ownerSql("select detail from automation_runs where rule_id = $1", [rule]))[0].detail).toBe("whatsapp_not_connected");
    ok(await s.c.post("/integrations/whatsapp/connect", { phoneNumberId: phone, accessToken: "EAAG-auto-token-1234" }), 201);
    const d2 = await s.deliver(10000); expect(ok(await s.c.post("/automation/run")).done).toBe(1);
    const msg = (await ownerSql<any>("select category, template, status from wa_messages where tenant_id = $1 order by created_at desc limit 1", [s.t.tenantId]))[0]; expect(msg).toMatchObject({ category: "utility", template: "os_entregue", status: "queued" });
    expect((await processOutbox(h, s.t.tenantId)).sent).toBe(1);
    expect(h.whatsapp.sent[h.whatsapp.sent.length - 1]!.msg).toMatchObject({ template: "os_entregue", params: ["Maria", expect.any(String)] }); void d2;
    // plano sem o recurso: o job não executa (mesmo com regra ativa gravada por fora)
    const pro = await setup({ plan: "PROFISSIONAL" });
    await ownerSql("insert into automation_rules (tenant_id, name, trigger_kind, action, config, enabled) values ($1,'regra','order.delivered','internal_note','{\"text\":\"x\"}', true)", [pro.t.tenantId]);
    await pro.deliver(10000); const rp = await runAutomations(h, { tenantId: pro.t.tenantId }); expect(rp.done).toBe(0); expect(rp.blocked.feature_not_in_plan).toBe(1);
  });
});
