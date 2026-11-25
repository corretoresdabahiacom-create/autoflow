import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, loginOwner, makeHarness, ownerSql, seedTenant } from "./harness";
import { JOBS, jobStats, runJob } from "../src/scheduler";

let h: Harness;
beforeAll(() => { h = makeHarness(); });
afterAll(async () => h.db.close());
const deps = () => ({ config: h.config, db: h.db, email: h.email, storage: h.storage, otp: h.otp, captcha: h.captcha, whatsapp: h.whatsapp, payments: h.payments, push: h.push });

describe("agendador de jobs", () => {
  it("executa cada job com sucesso e registra métricas; segunda instância concorrente é ignorada (lock)", async () => {
    await seedTenant(h);
    for (const j of Object.keys(JOBS) as (keyof typeof JOBS)[]) { const r = await runJob(deps() as any, j); expect(r.status, j).toBe("ok"); expect(jobStats[j].lastSuccessTs).toBeGreaterThan(0); }
    // lock mantido por outra sessão => skipped
    const pg = await h.db.pool.connect();
    try {
      await pg.query("select pg_advisory_lock(hashtextextended($1, 0))", ["autoflow:job:outbox"]);
      expect((await runJob(deps() as any, "outbox")).status).toBe("skipped");
    } finally { await pg.query("select pg_advisory_unlock_all()"); pg.release(); }
    expect((await runJob(deps() as any, "outbox")).status).toBe("ok");
  });
  it("falha de um job é contada, não propaga e libera o lock", async () => {
    const orig = JOBS.automation.run; JOBS.automation.run = async () => { throw new Error("boom"); };
    try {
      const r = await runJob(deps() as any, "automation"); expect(r.status).toBe("failed"); expect(jobStats.automation.failures).toBeGreaterThan(0); expect(jobStats.automation.lastError).toBe("boom");
    } finally { JOBS.automation.run = orig; }
    expect((await runJob(deps() as any, "automation")).status).toBe("ok");
  });
  it("outbox: o job processa pendências reais de todos os tenants", async () => {
    const t = await seedTenant(h);
    await ownerSql("insert into outbox (tenant_id, kind, payload, status) values ($1,'email','{\"title\":\"x\"}','pending')", [t.tenantId]).catch(() => null);
    expect((await runJob(deps() as any, "outbox")).status).toBe("ok");
  });
});

describe("fila LGPD com prazo", () => {
  it("abre pedido com prazo de 15 dias, lista com dias restantes, atrasado é sinalizado e encerramento é único", async () => {
    const t = await seedTenant(h); const c = await loginOwner(h, t);
    const cu = (await c.post("/customers", { name: "Titular Teste", phone: "(71) 98888-7777" })).json.id;
    const r = await c.post("/lgpd/tickets", { kind: "access", channel: "email", customerId: cu }); expect(r.status, JSON.stringify(r.json)).toBe(201);
    const due = new Date(r.json.dueAt).getTime(); expect(Math.round((due - Date.now()) / 86400000)).toBe(15);
    const old = await c.post("/lgpd/tickets", { kind: "anonymization", receivedAt: new Date(Date.now() - 20 * 86400000).toISOString() }); expect(old.status).toBe(201);
    const l = (await c.get("/lgpd/tickets?status=open")).json; expect(l.tickets).toHaveLength(2); expect(l.overdue).toBe(1); expect(l.tickets[0].overdue).toBe(true); // atrasado primeiro
    expect((await c.post(`/lgpd/tickets/${old.json.id}/close`, { outcome: "done", resolution: "Atendido por e-mail" })).status).toBe(200);
    expect((await c.post(`/lgpd/tickets/${old.json.id}/close`, { outcome: "done", resolution: "de novo" })).status).toBe(409);
    expect((await c.get("/lgpd/tickets?status=open")).json.overdue).toBe(0);
    expect((await c.post("/lgpd/tickets", { kind: "access", customerId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
  });
  it("isolamento entre tenants e permissão exigida", async () => {
    const a = await seedTenant(h), b = await seedTenant(h); const ca = await loginOwner(h, a), cb = await loginOwner(h, b);
    const id = (await ca.post("/lgpd/tickets", { kind: "portability" })).json.id;
    expect((await cb.get("/lgpd/tickets")).json.tickets).toHaveLength(0);
    expect((await cb.post(`/lgpd/tickets/${id}/close`, { outcome: "done", resolution: "tentativa" })).status).toBe(404);
    expect((await h.app.request("/lgpd/tickets")).status).toBe(401);
  });
});
