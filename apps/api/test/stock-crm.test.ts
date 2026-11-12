import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/password";
import { optOutPath } from "../src/optout";
import { processOutbox } from "../src/outbox";
import { Client, type Harness, type SeededTenant, PW, loginOwner, makeHarness, ownerSql, seedTenant, uniq } from "./harness";

let h: Harness;
beforeAll(() => { h = makeHarness(); });
afterAll(async () => h.db.close());

let ipn = 1;
const nextIp = () => `10.77.${Math.floor(ipn / 250)}.${(ipn++ % 250) + 1}`;
const today = new Date().toISOString().slice(0, 10);
const plateN = () => `STK${Math.floor(Math.random() * 9)}${"ABCDEFGHJK"[Math.floor(Math.random() * 10)]}${Math.floor(Math.random() * 90 + 10)}`;

async function addMember(t: SeededTenant, role: string, units?: string[]) {
  const email = `${uniq("m")}@example.test`;
  const u = await ownerSql<{ id: string }>("insert into users (email, password_hash) values ($1,$2) returning id", [email, await hashPassword(PW, 10)]);
  const r = await ownerSql<{ id: string }>("select id from roles where tenant_id is null and key = $1", [role]);
  const m = await ownerSql<{ id: string }>("insert into memberships (tenant_id, user_id, role_id, status, all_units) values ($1,$2,$3,'active',$4) returning id", [t.tenantId, u[0]!.id, r[0]!.id, !units]);
  for (const un of units ?? []) await ownerSql("insert into unit_memberships (tenant_id, membership_id, unit_id) values ($1,$2,$3)", [t.tenantId, m[0]!.id, un]);
  const cl = new Client(h, nextIp());
  expect((await cl.post("/auth/login", { email, password: PW, tenantSlug: t.slug })).status).toBe(200);
  return cl;
}
async function setup() {
  const t = await seedTenant(h); const c = await loginOwner(h, t, nextIp());
  const cu = await c.post("/customers", { name: "Maria Silva", phone: "(71) 99999-1234", email: "maria@example.test" });
  const ve = await c.post(`/customers/${cu.json.id}/vehicles`, { plate: plateN(), make: "VW" });
  const mkItem = async (sku: string, category = "part", extra: Record<string, unknown> = {}) => { const r = await c.post("/stock/items", { sku, name: `Item ${sku}`, category, ...extra }); expect(r.status, JSON.stringify(r.json)).toBe(201); return r.json.id as string; };
  const buy = async (itemId: string, q: number, totalCents: number, unitId?: string) => { const r = await c.post("/stock/purchases", { unitId, items: [{ itemId, qty: q, totalCents }] }); expect(r.status, JSON.stringify(r.json)).toBe(201); return r; };
  const order = async (unitId?: string, customerId = cu.json.id as string, vehicleId = ve.json.id as string) => { const o = await c.post("/orders", { customerId, vehicleId, unitId }); expect(o.status, JSON.stringify(o.json)).toBe(201); return o.json.id as string; };
  const level = async (itemId: string, unitId = t.unitIds[0]!) => (await c.get(`/stock/levels?unitId=${unitId}`)).json.levels.find((l: any) => l.itemId === itemId);
  const audit = async () => (await c.get("/stock/audit")).json;
  const ledgerBalance = async () => Number((await ownerSql<{ d: string }>("select coalesce(sum(case side when 'D' then amount_cents else -amount_cents end),0)::bigint d from ledger_entries where tenant_id = $1", [t.tenantId]))[0]!.d);
  const deliverable = async (osId: string, items: [string, string, number][] = [["Serviço", "service", 20000]]) => {
    for (const [description, category, unitPriceCents] of items) expect((await c.post(`/orders/${osId}/estimate/items`, { description, category, qty: 1, unitPriceCents })).status).toBe(201);
    expect((await c.post(`/orders/${osId}/estimate/publish`)).status).toBeLessThan(300);
    const est = (await c.get(`/orders/${osId}/estimate`)).json.versions.find((v: any) => v.status === "published");
    expect((await c.post(`/orders/${osId}/estimate/decisions`, { customerName: "Maria", decisions: est.items.map((i: any) => ({ itemId: i.id, decision: "approved" })) })).status).toBe(201);
    expect((await c.patch(`/orders/${osId}`, { status: "delivered" })).status).toBe(200);
  };
  const invoice = (osId: string, body: Record<string, unknown> = {}) => c.post(`/orders/${osId}/invoice`, { plan: { count: 1, firstDueDate: "2030-01-10" }, ...body });
  return { t, c, cu: cu.json.id as string, ve: ve.json.id as string, mkItem, buy, order, level, audit, ledgerBalance, deliverable, invoice };
}

describe("E1 movimentos append-only e saldo derivado", () => {
  it("UPDATE/DELETE em movimentos falham; app não grava saldo direto; auditoria consistente", async () => {
    const s = await setup(); const it = await s.mkItem("P1"); await s.buy(it, 10, 10000);
    const ctx = { actor: "tenant", tenantId: s.t.tenantId, unitScope: "all" } as const;
    await expect(h.db.tx(ctx, (q) => q.query("update stock_movements set qty_milli = 1"))).rejects.toThrow();
    await expect(h.db.tx(ctx, (q) => q.query("delete from stock_movements"))).rejects.toThrow();
    await expect(h.db.tx(ctx, (q) => q.query("update stock_levels set on_hand_milli = 999999"))).rejects.toThrow();
    await expect(h.db.tx(ctx, (q) => q.query("insert into stock_levels (tenant_id, unit_id, item_id, on_hand_milli) values ($1,$2,$3,5)", [s.t.tenantId, s.t.unitIds[1], it]))).rejects.toThrow();
    await expect(h.db.tx(ctx, (q) => q.query("update purchases set total_cents = 1"))).rejects.toThrow();
    expect((await s.audit()).consistent).toBe(true);
    expect((await s.level(it)).onHandMilli).toBe(10000);
  });
  it("concorrência: 5 consumos de 1 un com saldo 3 => exatamente 3 sucessos, saldo 0, sem negativo", async () => {
    const s = await setup(); const it = await s.mkItem("P2"); await s.buy(it, 3, 3000);
    const oss = await Promise.all([1, 2, 3, 4, 5].map(() => s.order()));
    const rs = await Promise.all(oss.map((os) => s.c.post(`/orders/${os}/stock/consume`, { itemId: it, qty: 1 })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(3); expect(rs.filter((r) => r.status === 409).map((r) => r.json.error)).toEqual(["insufficient_stock", "insufficient_stock"]);
    const l = await s.level(it); expect(l.onHandMilli).toBe(0); expect(l.valueCents).toBe(0);
    expect((await s.audit()).consistent).toBe(true); expect(await s.ledgerBalance()).toBe(0);
  });
});

describe("E2 custo médio móvel, reserva e devolução", () => {
  it("entradas/saídas/devolução com custo correto e razão consistente", async () => {
    const s = await setup(); const it = await s.mkItem("P3"); await s.buy(it, 10, 10000); await s.buy(it, 10, 14000);
    expect((await s.level(it)).avgUnitCostCents).toBe(1200);
    const os = await s.order(); const cons = await s.c.post(`/orders/${os}/stock/consume`, { itemId: it, qty: 5 });
    expect(cons.json.costCents).toBe(6000);
    const r1 = await s.c.post(`/orders/${os}/stock/return`, { movementId: cons.json.movementId, qty: 2, reason: "peça sobrando" }); expect(r1.json.costCents).toBe(2400);
    expect((await s.c.post(`/orders/${os}/stock/return`, { movementId: cons.json.movementId, qty: 4, reason: "excesso" })).status).toBe(409);
    const r2 = await s.c.post(`/orders/${os}/stock/return`, { movementId: cons.json.movementId, qty: 3, reason: "resto" }); expect(r2.json.costCents).toBe(3600); // 6000 − 2400 (sem resíduo)
    const l = await s.level(it); expect(l.onHandMilli).toBe(20000); expect(l.valueCents).toBe(24000);
    const lines = (await s.c.get(`/orders/${os}/stock`)).json; expect(lines.totalCostCents).toBe(0);
    expect((await s.audit()).consistent).toBe(true); expect(await s.ledgerBalance()).toBe(0);
  });
  it("reserva: não excede saldo disponível; consumo usa a reserva da própria OS; liberar; OS fechada não consome", async () => {
    const s = await setup(); const it = await s.mkItem("P4"); await s.buy(it, 5, 5000);
    const a = await s.order(); const b = await s.order();
    expect((await s.c.post(`/orders/${a}/stock/reserve`, { itemId: it, qty: 6 })).status).toBe(409);
    expect((await s.c.post(`/orders/${a}/stock/reserve`, { itemId: it, qty: 4 })).status).toBe(201);
    expect((await s.level(it)).availableMilli).toBe(1000);
    expect((await s.c.post(`/orders/${b}/stock/reserve`, { itemId: it, qty: 2 })).status).toBe(409);
    expect((await s.c.post(`/orders/${b}/stock/consume`, { itemId: it, qty: 2 })).status).toBe(409); // 4 reservadas por A
    expect((await s.c.post(`/orders/${a}/stock/consume`, { itemId: it, qty: 4 })).status).toBe(201); // usa a reserva
    let l = await s.level(it); expect(l.onHandMilli).toBe(1000); expect(l.reservedMilli).toBe(0);
    expect((await s.c.post(`/orders/${a}/stock/reserve`, { itemId: it, qty: 1 })).status).toBe(201);
    expect((await s.c.post(`/orders/${a}/stock/release`, { itemId: it, qty: 2 })).status).toBe(409);
    expect((await s.c.post(`/orders/${a}/stock/release`, { itemId: it, qty: 1 })).status).toBe(201);
    l = await s.level(it); expect(l.reservedMilli).toBe(0);
    expect((await s.c.post(`/orders/${b}/stock/consume`, { itemId: it, qty: 1.5 })).status).toBe(409);
    expect((await s.c.post(`/orders/${b}/stock/consume`, { itemId: it, qty: 0.0001 })).status).toBe(422);
    expect((await s.c.post(`/orders/${b}/stock/consume`, { itemId: it, qty: 0.5 })).status).toBe(201); // frações
    expect((await s.audit()).consistent).toBe(true);
    await s.deliverable(b); expect((await s.c.post(`/orders/${b}/stock/consume`, { itemId: it, qty: 0.1 })).status).toBe(409);
  });
  it("inventário gera ajustes compensatórios com razão; contagem abaixo do reservado é recusada; estoque mínimo e código de barras", async () => {
    const s = await setup(); const it = await s.mkItem("P5", "paint", { barcode: "7891234567895", minQty: 2, uom: "l" }); await s.buy(it, 10, 5000);
    const os = await s.order(); expect((await s.c.post(`/orders/${os}/stock/reserve`, { itemId: it, qty: 6 })).status).toBe(201);
    expect((await s.c.post("/stock/inventory", { reason: "contagem mensal", counts: [{ itemId: it, counted: 5 }] })).status).toBe(409);
    expect((await s.c.post("/stock/inventory", { reason: "x", counts: [{ itemId: it, counted: 8 }] })).status).toBe(422);
    const inv = await s.c.post("/stock/inventory", { reason: "contagem mensal", counts: [{ itemId: it, counted: 8 }] }); expect(inv.status).toBe(201);
    expect(inv.json.adjustments[0]).toMatchObject({ diffMilli: -2000, costCents: 1000 });
    const up = await s.c.post("/stock/inventory", { reason: "sobra achada", counts: [{ itemId: it, counted: 9 }] }); expect(up.json.adjustments[0].costCents).toBe(500);
    expect((await s.level(it)).onHandMilli).toBe(9000);
    expect((await s.c.get("/stock/levels?low=1")).json.levels.some((l: any) => l.itemId === it)).toBe(false);
    expect((await s.c.post("/stock/inventory", { reason: "perda", counts: [{ itemId: it, counted: 7 }] })).status).toBe(201);
    expect((await s.c.get(`/stock/levels?low=1&unitId=${s.t.unitIds[0]}`)).json.levels.some((l: any) => l.itemId === it)).toBe(true); // disponível 1 <= mínimo 2
    const bc = await s.c.get("/stock/items/by-barcode/7891234567895"); expect(bc.status).toBe(200); expect(bc.json.item.sku).toBe("P5");
    expect((await s.c.get("/stock/items/by-barcode/0000000000")).status).toBe(404);
    expect((await s.c.post("/stock/items", { sku: "P5", name: "dup", category: "part" })).status).toBe(409);
    expect((await s.audit()).consistent).toBe(true); expect(await s.ledgerBalance()).toBe(0);
  });
});

describe("E3 integração com o financeiro (Fase 5)", () => {
  it("consumo vira custo direto no ledger/DRE e no lucro por OS; devolução reverte", async () => {
    const s = await setup(); const part = await s.mkItem("P6", "part"); const paint = await s.mkItem("T1", "paint"); await s.buy(part, 10, 20000); await s.buy(paint, 4, 8000);
    const os = await s.order(); const c1 = await s.c.post(`/orders/${os}/stock/consume`, { itemId: part, qty: 2 }); await s.c.post(`/orders/${os}/stock/consume`, { itemId: paint, qty: 1 });
    expect(c1.json.costCents).toBe(4000);
    const rows = await ownerSql<{ key: string; net: string }>(`select a.system_key key, sum(case e.side when 'D' then e.amount_cents else -e.amount_cents end)::bigint net from ledger_entries e join fin_accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id where e.tenant_id = $1 group by a.system_key`, [s.t.tenantId]);
    const by = Object.fromEntries(rows.map((r) => [r.key, Number(r.net)]));
    expect(by).toMatchObject({ cost_parts: 4000, cost_materials: 2000, inventory: 28000 - 6000, grni: -28000 });
    const dre = (await s.c.get(`/finance/dre?from=${today}&to=${today}`)).json; expect(dre.directCosts).toBe(6000);
    await s.deliverable(os); expect((await s.invoice(os)).status).toBeLessThan(300);
    const profit = (await s.c.get(`/orders/${os}/profit`)).json; expect(profit.directCostsCents).toBe(6000); expect(profit.directCosts.some((x: any) => x.account === "Estoque (consumo)" && x.cents === 6000)).toBe(true);
    await s.c.post(`/orders/${os}/stock/return`, { movementId: c1.json.movementId, qty: 1, reason: "devolvida" });
    expect((await s.c.get(`/orders/${os}/profit`)).json.directCostsCents).toBe(4000);
    expect(await s.ledgerBalance()).toBe(0);
  });
});

describe("E4 isolamento por unidade e permissões", () => {
  it("estoque de uma unidade é invisível/inutilizável para outra; papéis", async () => {
    const s = await setup(); const it = await s.mkItem("P7"); await s.buy(it, 5, 5000, s.t.unitIds[0]);
    const u1 = await addMember(s.t, "stockkeeper", [s.t.unitIds[1]!]);
    const seen = (await u1.get(`/stock/levels?unitId=${s.t.unitIds[0]}`)).json.levels.find((l: any) => l.itemId === it); expect(seen?.onHandMilli ?? 0).toBe(0);
    expect((await u1.post("/stock/purchases", { unitId: s.t.unitIds[0], items: [{ itemId: it, qty: 1, totalCents: 100 }] })).status).toBe(403);
    expect((await s.c.get(`/stock/levels?unitId=${s.t.unitIds[1]}`)).json.levels.find((l: any) => l.itemId === it).onHandMilli).toBe(0);
    const osU1 = await s.order(s.t.unitIds[1]); expect((await s.c.post(`/orders/${osU1}/stock/consume`, { itemId: it, qty: 1 })).status).toBe(409); // estoque está na unidade 0
    expect((await s.c.get("/stock/movements?unitId=" + s.t.unitIds[0])).json.movements.length).toBeGreaterThan(0);
    expect((await u1.get(`/stock/movements?unitId=${s.t.unitIds[0]}`)).json.movements).toHaveLength(0);
    const keeper = await addMember(s.t, "stockkeeper"); const att = await addMember(s.t, "attendant"); const mec = await addMember(s.t, "mechanic");
    expect((await keeper.post("/stock/items", { sku: "K1", name: "Item K", category: "part" })).status).toBe(201);
    expect((await att.get("/stock/levels")).status).toBe(403); expect((await mec.post("/stock/purchases", { items: [{ itemId: it, qty: 1, totalCents: 1 }] })).status).toBe(403);
    expect((await mec.post(`/orders/${await s.order()}/stock/consume`, { itemId: it, qty: 1 })).status).toBe(403);
  });
});

const seedLead = async (s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) => {
  const v = { name: "João Lead", phone: "+5571988887777", plate: plateN(), campaign: "nov", status: "new", ...over };
  const r = await ownerSql<{ id: string }>("insert into leads (tenant_id, unit_id, source, campaign, name, phone_e164, plate, status, service) values ($1,$2,'site',$3,$4,$5,$6,$7,'Freios') returning id", [s.t.tenantId, s.t.unitIds[0], v.campaign, v.name, v.phone, v.plate, v.status]);
  return r[0]!.id;
};

describe("C1 conversão de lead", () => {
  it("lead → cliente + veículo + OS; estado 'won'; evento; reuso de cliente por telefone; 409 ao reconverter", async () => {
    const s = await setup(); const l = await seedLead(s);
    const r = await s.c.post(`/leads/${l}/convert`, { createOrder: true, vehicle: { plate: "ZZZ9Z99", make: "Fiat" } }); expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toMatchObject({ status: "won" }); expect(r.json.orderNumber).toBeGreaterThan(0);
    const cu = await ownerSql<any>("select * from customers where id = $1", [r.json.customerId]); expect(cu[0]).toMatchObject({ name: "João Lead", marketing_opt_in: false });
    expect((await s.c.get(`/leads/${l}`)).json.events.map((e: any) => e.kind)).toEqual(["converted"]);
    expect((await s.c.post(`/leads/${l}/convert`, { createOrder: true })).status).toBe(409);
    const l2 = await seedLead(s); const r2 = await s.c.post(`/leads/${l2}/convert`, { scheduledFor: new Date(Date.now() + 86400_000).toISOString(), vehicle: { plate: "ZZZ9Z99" } });
    expect(r2.json).toMatchObject({ status: "scheduled", customerId: r.json.customerId });
    const l3 = await seedLead(s, { phone: "+5571911112222" }); expect((await s.c.post(`/leads/${l3}/convert`, { vehicle: { plate: "ZZZ9Z99" }, createOrder: true })).status).toBe(409); // placa de outro cliente
    expect((await s.c.post(`/leads/${l3}/convert`, { createOrder: true, scheduledFor: new Date(Date.now() + 86400_000).toISOString() })).status).toBe(422);
    expect((await s.c.post(`/leads/${l3}/convert`, { createOrder: true, vehicle: { plate: "x" } })).status).toBe(422);
    const mec = await addMember(s.t, "mechanic"); expect((await mec.post(`/leads/${l3}/convert`, {})).status).toBe(403);
  });
});

describe("C2 consentimento, campanhas e opt-out", () => {
  it("campanha só para consentidos; opt-out imediato (mesmo enfileirado), auditável, e link público assinado", async () => {
    const s = await setup();
    const mk = async (name: string, email: string | null, optIn: boolean) => (await s.c.post("/customers", { name, phone: `(71) 9${Math.floor(Math.random() * 9e7 + 1e7)}`, email: email ?? undefined, marketingOptIn: optIn })).json.id as string;
    const a = await mk("Ana Consentiu", "ana@example.test", true); const b = await mk("Beto Sem", "beto@example.test", false); const c3 = await mk("Cris Sem Email", null, true);
    const prev = await s.c.post("/crm/campaigns/preview", { kind: "custom" }); expect(prev.json).toMatchObject({ excludedNoConsent: 2, excludedNoContact: 1 }); // 2: Beto + cliente do setup (sem opt-in)
    const camp = await s.c.post("/crm/campaigns", { kind: "custom", name: "Promo de novembro" }); expect(camp.status).toBe(201); expect(camp.json.queued).toBe(1);
    const outbox = await ownerSql<any>("select payload from outbox where tenant_id = $1 and kind = 'campaign'", [s.t.tenantId]); expect(outbox).toHaveLength(1); expect(outbox[0].payload.customerId).toBe(a);
    const sentBefore = h.email.sent.length;
    // opt-out por SQL direto simula corrida: já enfileirado, cliente revoga antes do envio
    await ownerSql("update customers set marketing_opt_in = false where id = $1", [a]);
    const pr = await processOutbox(h, s.t.tenantId); expect(pr.sent).toBe(0); expect(h.email.sent.length).toBe(sentBefore);
    expect((await ownerSql("select last_error from outbox where tenant_id = $1 and kind = 'campaign'", [s.t.tenantId]))[0].last_error).toBe("opted_out");
    // reabilita e envia: e-mail traz link de opt-out
    expect((await s.c.post(`/crm/customers/${a}/consent`, { optIn: true, source: "phone" })).status).toBe(200);
    expect((await s.c.post("/crm/campaigns", { kind: "custom", name: "Segunda" })).json.queued).toBe(1);
    expect((await processOutbox(h, s.t.tenantId)).sent).toBe(1);
    const msg = h.email.sent[h.email.sent.length - 1]!; expect(msg.to).toBe("ana@example.test"); expect(msg.vars.optOutUrl).toContain("/optout/");
    const path = msg.vars.optOutUrl!.replace("http://localhost:8787", "");
    expect((await h.app.request(path)).status).toBe(200);
    expect((await h.app.request(path.replace(/sig=.{4}/, "sig=0000"), { method: "POST", headers: { origin: "http://localhost:8787" } })).status).toBe(404);
    expect((await h.app.request(path, { method: "POST", headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect((await h.app.request(path, { method: "POST", headers: { origin: "http://localhost:8787" } })).status).toBe(200);
    expect((await ownerSql("select marketing_opt_in from customers where id = $1", [a]))[0].marketing_opt_in).toBe(false);
    const log = (await s.c.get(`/crm/customers/${a}/consent-log`)).json.log; expect(log.map((x: any) => `${x.action}:${x.source}`)).toEqual(["grant:staff", "revoke:staff", "grant:phone", "revoke:self_service_link"]);
    expect((await s.c.post("/crm/campaigns", { kind: "custom", name: "Terceira" })).json.queued).toBe(0);
    await expect(h.db.tx({ actor: "tenant", tenantId: s.t.tenantId, unitScope: "all" }, (q) => q.query("delete from marketing_consent_log"))).rejects.toThrow();
    void b; void c3; void optOutPath;
    const att = await addMember(s.t, "attendant"); expect((await att.post("/crm/campaigns", { kind: "custom", name: "Nope" })).status).toBe(403);
  });
  it("públicos: inativos, recuperação de orçamento e lembretes", async () => {
    const s = await setup(); await s.c.patch(`/customers/${s.cu}`, { marketingOptIn: true });
    const os = await s.order(); await s.deliverable(os);
    expect((await s.c.post("/crm/campaigns/preview", { kind: "inactive" })).json.eligible).toBe(0);
    await ownerSql("update service_orders set created_at = now() - interval '200 days' where id = $1", [os]);
    expect((await s.c.post("/crm/campaigns/preview", { kind: "inactive", params: { inactiveDays: 180 } })).json.eligible).toBe(1);
    const os2 = await s.order(); await s.c.post(`/orders/${os2}/estimate/items`, { description: "Freio", category: "part", qty: 1, unitPriceCents: 9000 }); await s.c.post(`/orders/${os2}/estimate/publish`);
    expect((await s.c.post("/crm/campaigns/preview", { kind: "quote_recovery", params: { staleDays: 3 } })).json.eligible).toBe(0);
    await ownerSql("alter table estimate_versions disable trigger estimate_versions_guard"); // versão publicada é imutável: só o teste retrocede a data
    await ownerSql("update estimate_versions set published_at = now() - interval '5 days' where tenant_id = $1 and status = 'published'", [s.t.tenantId]);
    await ownerSql("alter table estimate_versions enable trigger estimate_versions_guard");
    expect((await s.c.post("/crm/campaigns/preview", { kind: "quote_recovery", params: { staleDays: 3 } })).json.eligible).toBe(1);
    const rec = await s.c.post(`/crm/orders/${os}/reminders`, { items: [{ kind: "oil" }, { kind: "alignment", inDays: 3 }] }); expect(rec.json.created).toBe(2);
    expect((await s.c.post(`/crm/orders/${os}/reminders`, { items: [{ kind: "oil" }] })).json.created).toBe(0); // idempotente
    expect((await s.c.get(`/crm/reminders?until=${new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10)}`)).json.reminders.map((r: any) => r.kind)).toEqual(["alignment"]);
    expect((await s.c.post("/crm/campaigns/preview", { kind: "reminders", params: { daysAhead: 7 } })).json.eligible).toBe(1);
    const camp = await s.c.post("/crm/campaigns", { kind: "reminders", name: "Lembretes", params: { daysAhead: 7 } }); expect(camp.json.queued).toBe(1);
    expect((await s.c.get("/crm/reminders?status=queued")).json.reminders).toHaveLength(1);
    await s.c.post(`/crm/customers/${s.cu}/consent`, { optIn: false });
    expect((await s.c.get("/crm/reminders?status=cancelled")).json.reminders).toHaveLength(2); // opt-out cancela pendentes e enfileirados
    expect((await ownerSql("select status from outbox where tenant_id = $1 and kind = 'campaign'", [s.t.tenantId])).every((o: any) => o.status === "skipped")).toBe(true);
  });
});

describe("C3 fidelidade, indicações e cupons", () => {
  it("pontos por OS faturada (idempotente), indicação premia indicador, resgate serializado", async () => {
    const s = await setup(); const os = await s.order(); await s.deliverable(os, [["Serviço", "service", 25050]]);
    expect((await s.c.post(`/crm/orders/${os}/award-points`)).status).toBe(409); // não faturada
    await s.invoice(os);
    const friend = (await s.c.post("/customers", { name: "Amigo Indicado", phone: "(71) 98888-0001" })).json.id; const fv = (await s.c.post(`/customers/${friend}/vehicles`, { plate: plateN() })).json.id;
    expect((await s.c.post("/crm/referrals", { referrerCustomerId: s.cu, referredCustomerId: s.cu })).status).toBe(422);
    expect((await s.c.post("/crm/referrals", { referrerCustomerId: s.cu, referredCustomerId: friend })).status).toBe(201);
    expect((await s.c.post("/crm/referrals", { referrerCustomerId: s.cu, referredCustomerId: friend })).status).toBe(409);
    const a = await s.c.post(`/crm/orders/${os}/award-points`); expect(a.json).toMatchObject({ points: 250, awarded: true, referralPoints: 0 });
    expect((await s.c.post(`/crm/orders/${os}/award-points`)).status).toBe(409);
    const os2 = await s.order(undefined, friend, fv); await s.deliverable(os2, [["Serviço", "service", 10000]]); await s.invoice(os2);
    const b = await s.c.post(`/crm/orders/${os2}/award-points`); expect(b.json).toMatchObject({ points: 100, referralPoints: 100 });
    expect((await s.c.get(`/crm/customers/${s.cu}/loyalty`)).json.balance).toBe(350);
    const reds = await Promise.all([1, 2, 3].map(() => s.c.post(`/crm/customers/${s.cu}/points/redeem`, { points: 200, note: "desconto" })));
    expect(reds.filter((r) => r.status === 200)).toHaveLength(1); expect(reds.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await s.c.get(`/crm/customers/${s.cu}/loyalty`)).json.balance).toBe(150);
    expect((await s.c.put("/crm/loyalty/settings", { pointsPerReal: 2, referralBonusPoints: 50 })).status).toBe(200);
  });
  it("cupom: validade, mínimo, exclusividade, limite de usos e uso único por OS", async () => {
    const s = await setup(); const os = await s.order(); await s.deliverable(os, [["Serviço", "service", 20000]]); const os2 = await s.order(); await s.deliverable(os2, [["Serviço", "service", 20000]]);
    const other = (await s.c.post("/customers", { name: "Outro", phone: "(71) 98888-0002" })).json.id;
    expect((await s.c.post("/crm/coupons", { code: "ten", kind: "percent", value: 10, maxUses: 1 })).status).toBe(201);
    expect((await s.c.post("/crm/coupons", { code: "TEN", kind: "percent", value: 10 })).status).toBe(409);
    expect((await s.c.post("/crm/coupons", { code: "BAD", kind: "percent", value: 150 })).status).toBe(422);
    const r = await s.c.post("/crm/coupons/redeem", { code: "ten", osId: os }); expect(r.status).toBe(201); expect(r.json.discountCents).toBe(2000);
    expect((await s.c.post("/crm/coupons/redeem", { code: "TEN", osId: os })).status).toBe(409);
    expect((await s.c.post("/crm/coupons/redeem", { code: "TEN", osId: os2 })).status).toBe(409); // esgotado
    await s.c.post("/crm/coupons", { code: "MIN", kind: "fixed", value: 500, minTotalCents: 50000 }); expect((await s.c.post("/crm/coupons/redeem", { code: "MIN", osId: os2 })).status).toBe(422);
    await s.c.post("/crm/coupons", { code: "OLD", kind: "fixed", value: 500, validUntil: "2020-01-01" }); expect((await s.c.post("/crm/coupons/redeem", { code: "OLD", osId: os2 })).status).toBe(422);
    await s.c.post("/crm/coupons", { code: "VIP", kind: "fixed", value: 500, customerId: other }); expect((await s.c.post("/crm/coupons/redeem", { code: "VIP", osId: os2 })).status).toBe(422);
    expect((await s.c.post("/crm/coupons/redeem", { code: "NAOEXISTE", osId: os2 })).status).toBe(404);
    const par = await s.c.post("/crm/coupons", { code: "ONE", kind: "fixed", value: 100, maxUses: 1 }); expect(par.status).toBe(201);
    const os3 = await s.order(); await s.deliverable(os3, [["Serviço", "service", 20000]]);
    const two = await Promise.all([os2, os3].map((o) => s.c.post("/crm/coupons/redeem", { code: "ONE", osId: o }))); expect(two.map((x) => x.status).sort()).toEqual([201, 409]);
  });
  it("satisfação: só OS entregue, uma por OS, NPS", async () => {
    const s = await setup(); const os = await s.order(); expect((await s.c.post(`/crm/orders/${os}/satisfaction`, { score: 9 })).status).toBe(409);
    await s.deliverable(os); expect((await s.c.post(`/crm/orders/${os}/satisfaction`, { score: 11 })).status).toBe(422);
    expect((await s.c.post(`/crm/orders/${os}/satisfaction`, { score: 10, comment: "ótimo" })).status).toBe(201); expect((await s.c.post(`/crm/orders/${os}/satisfaction`, { score: 3 })).status).toBe(409);
    const os2 = await s.order(); await s.deliverable(os2); await s.c.post(`/crm/orders/${os2}/satisfaction`, { score: 4 });
    const m = (await s.c.get("/crm/metrics")).json.satisfaction; expect(m).toMatchObject({ responses: 2, nps: 0, average: 7 });
  });
});

describe("C4 métricas reconciliam com o ledger", () => {
  it("receita gerada por leads convertidos == ledger == faturas (com desconto e estorno); taxa de conversão", async () => {
    const s = await setup(); const l1 = await seedLead(s); await seedLead(s, { campaign: "outra" });
    const cv = await s.c.post(`/leads/${l1}/convert`, { createOrder: true, vehicle: { plate: plateN() } }); const os = cv.json.orderId as string;
    await s.deliverable(os, [["Serviço", "service", 30000], ["Peça", "part", 10000]]);
    const inv = await s.invoice(os, { discountCents: 1000, discountReason: "fidelidade" }); expect(inv.status, JSON.stringify(inv.json)).toBeLessThan(300);
    const m = (await s.c.get("/crm/metrics")).json;
    expect(m.leads).toMatchObject({ total: 2, converted: 1, won: 1, conversionRate: 0.5 }); expect(m.leads.byCampaign.find((x: any) => x.campaign === "nov")).toMatchObject({ leads: 1, converted: 1 });
    expect(m).toMatchObject({ revenueGeneratedCents: 39000, invoicedCents: 39000, reconciled: true, convertedOrders: 1 });
    const direct = await ownerSql<{ s: string }>(`select coalesce(sum(case when a.type='revenue' then (case e.side when 'C' then e.amount_cents else -e.amount_cents end) else (case e.side when 'D' then -e.amount_cents else e.amount_cents end) end),0)::bigint s from ledger_txns t join ledger_entries e on e.tenant_id=t.tenant_id and e.txn_id=t.id join fin_accounts a on a.tenant_id=e.tenant_id and a.id=e.account_id where t.os_id=$1 and a.type in ('revenue','deduction')`, [os]);
    expect(Number(direct[0]!.s)).toBe(m.revenueGeneratedCents);
    expect((await s.c.get("/crm/metrics?from=2000-01-01&to=2000-01-02")).json.leads.total).toBe(0);
  });
});
