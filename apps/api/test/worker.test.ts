import { afterAll, describe, expect, it } from "vitest";
import worker, { CRON_JOBS, type WorkerEnv } from "../src/worker";
import { Db } from "../src/db";
import { jobStats } from "../src/scheduler";
import { MemoryStorage } from "../src/storage";

const assets = { fetch: async (r: Request) => new Response(`ASSET:${new URL(r.url).pathname}`, { status: 200 }) };
const env = (over: Record<string, unknown> = {}): WorkerEnv => ({
  HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL! }, ASSETS: assets,
  NODE_ENV: "development", ALLOWED_ORIGINS: "http://localhost:5173", PASSWORD_SCRYPT_LOG_N: "10", ...over,
});
const dbs: Db[] = [];
afterAll(async () => { for (const d of dbs) await d.close(); });

describe("entrada Cloudflare Worker (roteamento, Db por transação, cron)", () => {
  it("/api/* remove o prefixo e atende pela API; raiz de SSR/saúde também; o resto vai para os assets (SPA)", async () => {
    const e = env();
    const h = await worker.fetch(new Request("https://x.test/api/health"), e); expect(h.status).toBe(200); expect(await h.json()).toEqual({ ok: true });
    const r = await worker.fetch(new Request("https://x.test/ready"), e); expect(r.status).toBe(200); expect(((await r.json()) as any).db).toBe("up"); // pg com conexão por transação
    expect((await worker.fetch(new Request("https://x.test/robots.txt"), e)).status).toBe(200);
    const spa = await worker.fetch(new Request("https://x.test/qualquer/rota/do/front"), e); expect(await spa.text()).toBe("ASSET:/qualquer/rota/do/front");
    const unauth = await worker.fetch(new Request("https://x.test/api/customers"), e); expect(unauth.status).toBe(401);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("falha de configuração em produção responde 500 genérico, sem vazar detalhe", async () => {
    const bad = env({ NODE_ENV: "production", HYPERDRIVE: { connectionString: "postgres://x:y@127.0.0.1:1/none?z=1" } }); // sem APP_ENCRYPTION_KEY
    const r = await worker.fetch(new Request("https://x.test/api/health"), bad); expect(r.status).toBe(500);
    const t = await r.text(); expect(t).toBe('{"error":"internal_error"}'); expect(t).not.toMatch(/APP_ENCRYPTION_KEY|Configuração/);
  });
  it("scheduled(): cada cron dispara seus jobs; cron desconhecido é ignorado", async () => {
    const e = env(); const waits: Promise<unknown>[] = []; const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
    expect(Object.keys(CRON_JOBS)).toEqual(["* * * * *", "*/5 * * * *", "0 * * * *"]);
    const before = jobStats.outbox.lastRunTs;
    await worker.scheduled({ cron: "* * * * *" }, e, ctx); await Promise.all(waits);
    expect(jobStats.outbox.lastRunTs).toBeGreaterThan(before); expect(jobStats.webhooks.lastSuccessTs).toBeGreaterThan(0);
    const n = waits.length; await worker.scheduled({ cron: "9 9 9 9 9" }, e, ctx); expect(waits.length).toBe(n);
  });
  it("Db perTx: abre e fecha um cliente por transação e mantém RLS/rollback", async () => {
    const db = new Db(process.env.TEST_DATABASE_URL!, 1, { perTx: true }); dbs.push(db);
    expect((await db.tx({ actor: "platform" }, (q) => q.one<{ n: number }>("select 1 as n")))?.n).toBe(1);
    await expect(db.tx({ actor: "platform" }, async (q) => { await q.query("select 1"); throw new Error("x"); })).rejects.toThrow("x");
    expect(db.pool.totalCount).toBe(0); // nada foi emprestado do pool
    const a = await db.acquire(); await a.release();
  });
  it("R2Storage valida chaves e usa o bucket (sem `..`, sem barras duplas)", async () => {
    const { R2Storage } = await import("../src/storage"); const store = new Map<string, Uint8Array>();
    const s = new R2Storage({ put: async (k, v) => { store.set(k, v); }, get: async (k) => (store.has(k) ? { arrayBuffer: async () => store.get(k)!.buffer as ArrayBuffer } : null) });
    await s.put("t1/a.png", new Uint8Array([1, 2])); expect([...(await s.get("t1/a.png"))!]).toEqual([1, 2]); expect(await s.get("t1/x")).toBeNull();
    for (const k of ["../x", "a/../b", "a//b", "", "/abs"]) await expect(s.put(k, new Uint8Array([1]))).rejects.toThrow();
    void MemoryStorage;
  });
});
