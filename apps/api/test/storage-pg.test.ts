import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, makeHarness, ownerSql, seedTenant } from "./harness";
import { PgStorage } from "../src/storage-pg";

let h: Harness;
beforeAll(() => { h = makeHarness(); });
afterAll(async () => h.db.close());

describe("PgStorage (arquivos no Postgres)", () => {
  it("grava, lê, é idempotente e valida a chave", async () => {
    const t = await seedTenant(h); const s = new PgStorage(h.db); const key = `${t.tenantId}/os/arquivo-1`;
    await s.put(key, new Uint8Array([1, 2, 3])); await s.put(key, new Uint8Array([9, 9]));
    expect([...(await s.get(key))!]).toEqual([1, 2, 3]); expect(await s.get(`${t.tenantId}/os/nao-existe`)).toBeNull();
    for (const k of ["../x", "abc/def", `${t.tenantId}/../x`, `${t.tenantId}//x`, ""]) await expect(s.put(k, new Uint8Array([1]))).rejects.toThrow();
  });
  it("o banco recusa chave de um tenant gravada com tenant_id de outro e acesso fora do ator system", async () => {
    const a = await seedTenant(h), b = await seedTenant(h);
    await expect(ownerSql("insert into file_blobs (key, tenant_id, bytes) values ($1,$2,'\\x01')", [`${a.tenantId}/os/falso-0000000000000000000000000`, b.tenantId])).rejects.toThrow();
    const rows = await h.db.tx({ actor: "tenant", tenantId: a.tenantId }, (q) => q.many("select key from file_blobs")); expect(rows).toHaveLength(0); // tenant não lê blobs direto
  });
});
