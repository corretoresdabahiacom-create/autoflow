import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { Client, type Harness, PW, loginOwner, makeHarness, ownerSql, seedTenant, uniq } from "./harness";

let h: Harness;
beforeAll(() => { h = makeHarness(); });
afterAll(async () => h.db.close());
const ok = (r: { status: number; json: any }, code = 200) => { expect(r.status, JSON.stringify(r.json)).toBe(code); return r.json; };
let n = 1; const ip = () => `10.98.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
const PLATE = () => `PTK${Math.floor(Math.random() * 9)}${"ABCDEFGHJK"[Math.floor(Math.random() * 10)]}${Math.floor(Math.random() * 90 + 10)}`;

describe("O1 observabilidade: /ready, /metrics e cabeçalhos", () => {
  it("/ready checa o banco; /metrics exige token, não vaza PII e usa rota por padrão", async () => {
    expect((await new Client(h, ip()).get("/ready")).json).toEqual({ ok: true, db: "up" });
    expect((await new Client(h, ip()).get("/metrics")).status).toBe(404); // sem METRICS_TOKEN configurado o endpoint não existe
    const token = "t".repeat(32);
    const cfg = loadConfig({ NODE_ENV: "test", DATABASE_URL: process.env.TEST_DATABASE_URL!, PASSWORD_SCRYPT_LOG_N: "10", ALLOWED_ORIGINS: "http://localhost:5173", METRICS_TOKEN: token });
    const { app } = createApp({ ...h, config: cfg });
    const t = await seedTenant(h); const owner = await loginOwner(h, t, ip());
    const cu = ok(await owner.post("/customers", { name: "Cliente Métrica", phone: "(71) 99999-4321" }), 201).id;
    await owner.get(`/customers/${cu}`); await new Client(h, ip()).get("/nao-existe");
    const res = (a: string | null) => app.request("/metrics", { headers: a ? { authorization: a } : {} });
    expect((await res(null)).status).toBe(401); expect((await res("Bearer errado")).status).toBe(401);
    const m = await (await res(`Bearer ${token}`)).text();
    // as chamadas acima foram em outra instância do app (harness); gera tráfego na instância medida
    await app.request("/health"); await app.request("/ready"); await app.request("/rota-inexistente");
    const m2 = await (await res(`Bearer ${token}`)).text();
    expect(m2).toMatch(/autoflow_http_requests_total\{method="GET",route="\/health",status="200"\} 1/);
    expect(m2).toContain('route="(unmatched)"'); expect(m2).toContain("autoflow_db_up 1"); expect(m2).toContain("autoflow_outbox_pending"); expect(m2).toContain("autoflow_webhook_dead");
    expect(m2 + m).not.toMatch(/Cliente Métrica|99999-4321|99999/); // sem PII
    expect(m2).not.toMatch(new RegExp(cu)); // rota por padrão: ids não viram label
  });
  it("cabeçalhos de segurança em respostas JSON e erros; HSTS só em produção", async () => {
    const r = await new Client(h, ip()).get("/health");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff"); expect(r.headers.get("x-frame-options")).toBe("DENY"); expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'"); expect(r.headers.get("cache-control")).toBe("no-store"); expect(r.headers.get("strict-transport-security")).toBeNull();
    const e = await new Client(h, ip()).get("/orders/00000000-0000-0000-0000-000000000000"); expect(e.status).toBe(401); expect(e.headers.get("x-content-type-options")).toBe("nosniff");
    expect(JSON.stringify(e.json)).not.toMatch(/at \w+|node_modules|stack/i);
  });
});

describe("L1 LGPD: exportação e anonimização do titular", () => {
  it("exporta tudo do titular; anonimiza preservando o que a lei manda guardar; bloqueia com obrigação em aberto", async () => {
    const t = await seedTenant(h); const c = await loginOwner(h, t, ip());
    const cu = ok(await c.post("/customers", { name: "Joana Titular", phone: "(71) 98888-7777", email: "joana@example.test", marketingOptIn: true }), 201).id;
    const ve = ok(await c.post(`/customers/${cu}/vehicles`, { plate: PLATE(), make: "Fiat" }), 201).id;
    const os = ok(await c.post("/orders", { customerId: cu, vehicleId: ve }), 201).id;
    await ownerSql("insert into leads (tenant_id, unit_id, name, phone_e164, email, description) values ($1,$2,'Joana Lead','+5571988887777','joana@example.test','quero orçamento')", [t.tenantId, t.unitIds[0]]);
    // exportação: completa, auditada sem conteúdo, exige permissão
    const ex = ok(await c.get(`/customers/${cu}/export`)); expect(ex.customer.name).toBe("Joana Titular"); expect(ex.vehicles).toHaveLength(1); expect(ex.orders).toHaveLength(1); expect(ex.leads).toHaveLength(1); expect(ex.leads[0].ip_hash).toBeUndefined();
    expect((await ownerSql("select details from lgpd_requests where customer_id = $1 and kind = 'export'", [cu]))[0].details).toMatchObject({ orders: 1 });
    expect(JSON.stringify(await ownerSql("select metadata from audit_log where action = 'lgpd.export' and tenant_id = $1", [t.tenantId]))).not.toContain("Joana");
    // OS aberta: não anonimiza
    expect((await c.post(`/customers/${cu}/anonymize`, { reason: "pedido do titular", confirm: "ANONIMIZAR" })).json.error).toBe("has_open_obligations");
    expect((await c.post(`/customers/${cu}/anonymize`, { reason: "pedido do titular" })).status).toBe(422); // confirmação explícita obrigatória
    ok(await c.patch(`/orders/${os}`, { status: "cancelled", reason: "teste" }));
    await ownerSql("insert into wa_messages (tenant_id, customer_id, direction, category, template, to_phone) values ($1,$2,'out','utility','aviso','+5571988887777')", [t.tenantId, cu]);
    const an = ok(await c.post(`/customers/${cu}/anonymize`, { reason: "pedido do titular", confirm: "ANONIMIZAR" }));
    expect(an).toMatchObject({ anonymized: true, leadsAnonymized: 1, waCancelled: 1, waPhonesErased: 1 });
    const row = (await ownerSql<any>("select name, phone_e164, email, marketing_opt_in, anonymized_at from customers where id = $1", [cu]))[0];
    expect(row).toMatchObject({ name: "Titular anonimizado", phone_e164: null, email: null, marketing_opt_in: false }); expect(row.anonymized_at).not.toBeNull();
    expect((await ownerSql("select name, email, description from leads where tenant_id = $1", [t.tenantId]))[0]).toMatchObject({ name: "Titular anonimizado", email: null, description: null });
    expect((await ownerSql("select count(*)::int n from service_orders where customer_id = $1", [cu]))[0].n).toBe(1); // OS mantida (obrigação legal)
    expect((await ownerSql("select count(*)::int n from marketing_consent_log where customer_id = $1", [cu]))[0].n).toBeGreaterThanOrEqual(2); // histórico de consentimento mantido
    expect(JSON.stringify(await ownerSql("select * from audit_log where tenant_id = $1", [t.tenantId]))).not.toMatch(/joana@|98888-7777|988887777/i);
    expect((await c.post(`/customers/${cu}/anonymize`, { reason: "de novo", confirm: "ANONIMIZAR" })).json.error).toBe("already_anonymized");
    await expect(ownerSql("delete from lgpd_requests where customer_id = $1", [cu])).rejects.toThrow(); // evidência append-only
    // cliente da OUTRA oficina não é visível (isolamento) e quem não é owner/admin não pode
    const other = await loginOwner(h, await seedTenant(h), ip()); expect((await other.get(`/customers/${cu}/export`)).status).toBe(404);
    const email = `${uniq("a")}@example.test`; const inv = ok(await c.post("/members/invite", { email, roleKey: "attendant", allUnits: true }), 201);
    const att = new Client(h, ip()); ok(await att.post("/auth/invite/accept", { token: inv.devToken, password: PW })); ok(await att.post("/auth/login", { email, password: PW, tenantSlug: t.slug }));
    expect((await att.get(`/customers/${cu}/export`)).json.error).toBe("permission_denied");
  });
  it("com parcela a receber em aberto, não anonimiza", async () => {
    const t = await seedTenant(h); const c = await loginOwner(h, t, ip());
    const cu = ok(await c.post("/customers", { name: "Devedor Teste", phone: "(71) 97777-1111" }), 201).id;
    const ve = ok(await c.post(`/customers/${cu}/vehicles`, { plate: PLATE(), make: "VW" }), 201).id;
    const os = ok(await c.post("/orders", { customerId: cu, vehicleId: ve }), 201).id;
    await c.post(`/orders/${os}/estimate/items`, { description: "Serviço", category: "service", qty: 1, unitPriceCents: 10000 }); await c.post(`/orders/${os}/estimate/publish`);
    const est = (await c.get(`/orders/${os}/estimate`)).json.versions.find((v: any) => v.status === "published");
    await c.post(`/orders/${os}/estimate/decisions`, { customerName: "Devedor", decisions: est.items.map((i: any) => ({ itemId: i.id, decision: "approved" })) });
    ok(await c.patch(`/orders/${os}`, { status: "delivered" })); ok(await c.post(`/orders/${os}/invoice`, { plan: { count: 1, firstDueDate: "2030-01-10" } }), 201);
    expect((await c.post(`/customers/${cu}/anonymize`, { reason: "pedido do titular", confirm: "ANONIMIZAR" })).json.error).toBe("has_open_obligations");
  });
});
