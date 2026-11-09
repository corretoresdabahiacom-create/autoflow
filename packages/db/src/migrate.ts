import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/**
 * Aplica migrations pendentes em ordem, cada uma em transação própria.
 * Registra checksum; migration já aplicada e alterada depois => erro (nunca reescrever histórico).
 * Deve rodar com a role app_owner (nunca com app_rw).
 */
export async function migrate(url: string, dir: string = migrationsDir): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock(727274)");
    await client.query(`create table if not exists schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const done = await client.query<{ checksum: string }>(
        "select checksum from schema_migrations where version = $1",
        [file],
      );
      if (done.rowCount) {
        if (done.rows[0]!.checksum !== checksum) {
          throw new Error(`Migration ${file} foi alterada após ser aplicada (checksum divergente).`);
        }
        continue;
      }
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (version, checksum) values ($1, $2)", [file, checksum]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Falha na migration ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => undefined);
    await client.end();
  }
  return applied;
}
