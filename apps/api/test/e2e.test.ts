import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, PW, freshCode, makeHarness, ownerSql, seedPlatformUser, uniq } from "./harness";
import { hashPassword } from "../src/password";

let h: Harness;
beforeAll(() => { h = makeHarness(); });
afterAll(async () => h.db.close());
const ok = (r: { status: number; json: any }, code = 200) => { expect(r.status, JSON.stringify(r.json)).toBe(code); return r.json; };
let n = 1; const ip = () => `10.97.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;

/** Jornada completa de uma oficina nova: do provisionamento pelo Super Admin até o fechamento financeiro e os direitos do titular. */
describe("E2E: do provisionamento à entrega e ao financeiro", () => {
  it("fluxo ponta a ponta com 3 papéis + portal do cliente + financeiro + LGPD", async () => {
    // 1) Super Admin provisiona a oficina (Premium) e o dono aceita o convite
    const sa = await seedPlatformUser(h); const pc = new Client(h, ip());
    ok(await pc.post("/platform/auth/login", { email: sa.email, password: PW })); ok(await pc.post("/platform/auth/mfa/verify", { code: await freshCode("platform_users", sa.id, sa.secret) }));
    const slug = `e2e${Date.now().toString(36)}`; const ownerEmail = `${slug}@example.test`;
    const prov = ok(await pc.post("/platform/tenants", { name: "Oficina E2E", slug, planCode: "PREMIUM", ownerEmail }), 201);
    const owner = new Client(h, ip()); ok(await owner.post("/auth/invite/accept", { token: prov.devToken, password: PW })); ok(await owner.post("/auth/login", { email: ownerEmail, password: PW, tenantSlug: slug }));
    // 2) Equipe: mecânico convidado
    const mEmail = `mec-${slug}@example.test`; const inv = ok(await owner.post("/members/invite", { email: mEmail, roleKey: "mechanic", allUnits: true }), 201);
    const mech = new Client(h, ip()); ok(await mech.post("/auth/invite/accept", { token: inv.devToken, password: PW })); ok(await mech.post("/auth/login", { email: mEmail, password: PW, tenantSlug: slug }));
    // 3) Atendimento: cliente, veículo, OS, orçamento
    const cu = ok(await owner.post("/customers", { name: "Carlos Cliente", phone: "(71) 99999-0001", email: "carlos@example.test", marketingOptIn: false }), 201).id;
    const ve = ok(await owner.post(`/customers/${cu}/vehicles`, { plate: "PTK1A23", make: "Fiat", model: "Uno" }), 201).id;
    const os = ok(await owner.post("/orders", { customerId: cu, vehicleId: ve }), 201).id;
    for (const it of [{ description: "Troca de pastilhas", category: "service", qty: 1, unitPriceCents: 25000 }, { description: "Pastilha dianteira", category: "part", qty: 1, unitPriceCents: 15000 }]) ok(await owner.post(`/orders/${os}/estimate/items`, it), 201);
    ok(await owner.post(`/orders/${os}/estimate/publish`), 201);
    // 4) Cliente no portal: abre o link, vê a OS e aprova com OTP
    const link = ok(await owner.post(`/orders/${os}/portal-link`), 201); const portal = new Client(h, ip()); ok(await portal.post("/portal/session", { token: (link.url as string).split("#")[1] }));
    const view = ok(await portal.get("/portal/order")); expect(view.orderInfo.number).toBeGreaterThan(0); expect(JSON.stringify(view)).not.toMatch(/cost_cents|margin|unit_cost/i); // portal nunca expõe custo interno
    const otp = ok(await portal.post("/portal/approval/otp")); const code = otp.devCode ?? h.otp.sent.at(-1)!.code;
    ok(await portal.post("/portal/approval", { code, versionNo: view.estimate.versionNo, decisions: view.estimate.items.map((i: any) => ({ itemId: i.id, decision: "approved" })) }), 201);
    // 5) Produção: tarefa do mecânico
    const mm = await ownerSql<{ id: string }>("select m.id from memberships m join users u on u.id = m.user_id where u.email = $1", [mEmail]);
    const tk = ok(await owner.post(`/orders/${os}/tasks`, { title: "Freios", assigneeMembershipId: mm[0]!.id }), 201).id;
    ok(await mech.post(`/production/tasks/${tk}/start`)); ok(await mech.post(`/production/tasks/${tk}/complete`));
    expect((await mech.get(`/finance/receivables`)).status).toBe(403); // mecânico não vê financeiro
    // 6) Entrega, fatura em 2 parcelas, recebimento total idempotente
    ok(await owner.patch(`/orders/${os}`, { status: "delivered" }));
    const inv2 = ok(await owner.post(`/orders/${os}/invoice`, { plan: { count: 2, firstDueDate: "2030-01-10", intervalDays: 30 } }), 201);
    const wallet = ok(await owner.post("/finance/wallets", { name: "Caixa", kind: "cash", openingBalanceCents: 0 }), 201).id;
    const insts = (await owner.get("/finance/receivables")).json.installments.filter((i: any) => i.docId === inv2.id);
    expect(insts.reduce((s: number, i: any) => s + i.amountCents, 0)).toBe(40000);
    const key = `e2e-${uniq("k")}`; const rec = () => owner.req("POST", "/finance/receipts", { walletId: wallet, method: "pix", allocations: insts.map((i: any) => ({ installmentId: i.id, principalCents: i.amountCents })) }).then(() => null);
    void rec;
    const pay = async () => { const r = await h.app.request("/finance/receipts", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173", cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; "), "idempotency-key": key, "x-real-ip": "10.97.250.250" }, body: JSON.stringify({ walletId: wallet, method: "pix", allocations: insts.map((i: any) => ({ installmentId: i.id, principalCents: i.amountCents })) }) }); return { status: r.status, json: await r.json() as any }; };
    expect((await pay()).status).toBe(201); expect((await pay()).json.replayed).toBe(true);
    expect((await owner.get("/finance/receivables")).json.installments.filter((i: any) => i.docId === inv2.id).every((i: any) => i.openCents === 0 || i.status === "paid")).toBe(true);
    // 7) Integridade: ledger balanceado e DRE bate com o faturado; relatórios Premium disponíveis
    const bad = await ownerSql<any>("select txn_id from ledger_entries where tenant_id = (select id from tenants where slug = $1) group by txn_id having sum(case side when 'D' then amount_cents else -amount_cents end) <> 0", [slug]); expect(bad).toEqual([]);
    const dre = ok(await owner.get("/finance/dre?from=2020-01-01&to=2099-12-31&basis=accrual")); expect(dre.grossRevenue).toBe(40000);
    expect(ok(await owner.get("/reports/consolidated?from=2020-01-01&to=2099-12-31")).total.dre.grossRevenue).toBe(40000);
    // 8) Cliente vê status final no portal; auditoria registrou o percurso; direitos do titular
    expect(ok(await portal.get("/portal/order")).status).toBe("delivered");
    const acts = (await ownerSql<{ action: string }>("select distinct action from audit_log where tenant_id = (select id from tenants where slug = $1)", [slug])).map((a) => a.action);
    for (const a of ["tenant.provision", "task.start", "task.complete"]) expect(acts, a).toContain(a);
    const ex = ok(await owner.get(`/customers/${cu}/export`)); expect(ex.orders).toHaveLength(1);
    // 9) Isolamento: outra oficina não enxerga nada disto
    const other = new Client(h, ip()); const o2 = `o2${slug}`; const p2 = ok(await pc.post("/platform/tenants", { name: "Outra", slug: o2, planCode: "PREMIUM", ownerEmail: `${o2}@example.test` }), 201);
    ok(await other.post("/auth/invite/accept", { token: p2.devToken, password: PW })); ok(await other.post("/auth/login", { email: `${o2}@example.test`, password: PW, tenantSlug: o2 }));
    expect((await other.get(`/orders/${os}`)).status).toBe(404); expect((await other.get(`/customers/${cu}/export`)).status).toBe(404);
    void hashPassword;
  });
});
