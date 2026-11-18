import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { type Client, type Harness, loginOwner, makeHarness, seedTenant } from "./harness";

/** Carga local (opt-in: LOAD=1). Mede handler + Postgres em processo, SEM rede/TLS/proxy. Números de máquina de dev, não de produção. */
const run = process.env.LOAD ? describe : describe.skip;
let h: Harness; let c: Client;
const TARGET_MS = { read: 300, write: 600 }; // metas p95 definidas em docs/PERFORMANCE.md
beforeAll(() => { h = makeHarness(); });
afterAll(async () => h.db.close());

async function pool<T>(total: number, conc: number, fn: (i: number) => Promise<T>) {
  const lat: number[] = []; let next = 0; let errors = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (next < total) { const i = next++; const t = performance.now(); try { const r: any = await fn(i); if (r.status >= 400) errors++; } catch { errors++; } lat.push(performance.now() - t); } }));
  lat.sort((a, b) => a - b); const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]!;
  return { n: lat.length, errors, p50: +p(0.5).toFixed(1), p95: +p(0.95).toFixed(1), p99: +p(0.99).toFixed(1), max: +lat[lat.length - 1]!.toFixed(1) };
}

run("carga local", () => {
  it("p95 por endpoint principal dentro das metas", async () => {
    const t = await seedTenant(h); c = await loginOwner(h, t);
    await pool(150, 10, (i) => c.post("/customers", { name: `Cliente Carga ${i}`, phone: `(71) 9${String(70000000 + i)}` }));
    const cust = (await c.get("/customers")).json; const list: any[] = cust.items ?? cust.customers ?? cust;
    const cid = list[0].id; const vid = (await c.post(`/customers/${cid}/vehicles`, { plate: "LDK1A23", make: "VW", model: "Gol" })).json.id;
    const wallet = (await c.post("/finance/wallets", { name: "Cx", kind: "cash", openingBalanceCents: 0 })).json.id; void wallet;
    const res: Record<string, ReturnType<typeof pool> extends Promise<infer R> ? R : never> = {} as any;
    res["GET /customers"] = await pool(400, 20, () => c.get("/customers"));
    res["GET /orders"] = await pool(400, 20, () => c.get("/orders"));
    res["GET /finance/receivables"] = await pool(300, 20, () => c.get("/finance/receivables"));
    res["GET /finance/dre"] = await pool(200, 10, () => c.get("/finance/dre?from=2020-01-01&to=2099-12-31&basis=accrual"));
    res["GET /reports/consolidated"] = await pool(100, 10, () => c.get("/reports/consolidated?from=2020-01-01&to=2099-12-31"));
    res["POST /orders"] = await pool(100, 10, () => c.post("/orders", { customerId: cid, vehicleId: vid }));
    res["GET /health"] = await pool(500, 25, () => Promise.resolve(h.app.request("/health")).then((r) => ({ status: r.status })));
    writeFileSync(new URL("../../../docs/perf-results.json", import.meta.url), JSON.stringify({ when: new Date().toISOString(), note: "processo único, Postgres local, sem rede/TLS; máquina de dev", targetsMs: TARGET_MS, res }, null, 2));
    console.table(res);
    for (const [k, v] of Object.entries(res)) { expect(v.errors, k).toBe(0); expect(v.p95, k).toBeLessThan(k.startsWith("POST") ? TARGET_MS.write : TARGET_MS.read); }
  }, 180000);
});
