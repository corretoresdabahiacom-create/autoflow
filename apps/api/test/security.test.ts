import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, PW, loginOwner, makeHarness, seedTenant } from "./harness";

let h: Harness;
beforeAll(() => { h = makeHarness(); });
afterAll(async () => h.db.close());

/** Baseline automatizado de segurança (NÃO substitui pentest independente nem ZAP — ver KI-087/088). */
describe("baseline de segurança HTTP", () => {
  it("cabeçalhos de segurança em respostas de sucesso, erro e 404", async () => {
    for (const path of ["/health", "/rota-que-nao-existe", "/orders"]) {
      const r = await h.app.request(path);
      expect(r.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(r.headers.get("x-frame-options") ?? r.headers.get("content-security-policy"), path).toBeTruthy();
      expect(r.headers.get("x-powered-by")).toBeNull();
    }
  });
  it("erros não vazam stack, SQL nem caminhos internos", async () => {
    const bodies = [
      await (await h.app.request("/orders/not-a-uuid")).text(),
      await (await h.app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).text(),
      await (await h.app.request("/customers/'; drop table customers;--/export")).text(),
    ];
    for (const b of bodies) expect(b).not.toMatch(/node_modules|\bat\s+\S+\s+\(|select\s+.+\s+from|pg_|stack|\/home\//i);
  });
  it("rotas protegidas exigem sessão; /metrics sem token é negado", async () => {
    for (const p of ["/orders", "/customers", "/finance/receivables", "/reports/consolidated?from=2020-01-01&to=2030-01-01"]) expect((await h.app.request(p)).status, p).toBe(401);
    expect([401, 403, 404]).toContain((await h.app.request("/metrics")).status);
  });
  it("cookie de sessão: HttpOnly, SameSite e sem Domain amplo", async () => {
    const t = await seedTenant(h); const r = await h.app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173", "x-real-ip": "10.98.0.1" }, body: JSON.stringify({ email: t.owners.email, password: PW, tenantSlug: t.slug }) });
    const sc = r.headers.getSetCookie().join(";"); expect(sc).toMatch(/HttpOnly/i); expect(sc).toMatch(/SameSite=(Lax|Strict)/i); expect(sc).not.toMatch(/Domain=/i);
  });
  it("CSRF: mutação autenticada com Origin hostil é rejeitada", async () => {
    const t = await seedTenant(h); const c = await loginOwner(h, t);
    const r = await h.app.request("/customers", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }, body: JSON.stringify({ name: "X Y", phone: "(71) 99999-0000" }) });
    expect(r.status).toBe(403);
  });
  it("isolamento: tenant B não lê nem altera recursos do tenant A por ID", async () => {
    const a = await seedTenant(h), b = await seedTenant(h); const ca = await loginOwner(h, a), cb = await loginOwner(h, b);
    const id = (await ca.post("/customers", { name: "Cliente A", phone: "(71) 98888-0001" })).json.id;
    expect((await cb.get(`/customers/${id}`)).status).toBe(404);
    expect((await cb.patch(`/customers/${id}`, { name: "Hack" })).status).toBe(404);
    expect((await cb.get(`/customers/${id}/export`)).status).toBe(404);
  });
});
