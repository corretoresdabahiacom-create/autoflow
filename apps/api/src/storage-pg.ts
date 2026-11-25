import type { Db } from "./db";
import type { StorageProvider } from "./storage";

const KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[A-Za-z0-9][A-Za-z0-9._\-\/]{0,250}$/;

/**
 * Arquivos em Postgres (bytea). Útil quando não há R2/S3 (gratuito, sem cartão). Cada chamada usa transação própria com ator
 * 'system' (a tabela só aceita esse ator); a chave carrega o tenant e o banco confere o prefixo. Limites: o espaço do banco
 * (Neon free = 1 GB, compartilhado com os dados) e a lentidão de bytea em arquivos grandes. Migrar depois para R2/S3 é copiar
 * as linhas, pois as chaves são as mesmas.
 */
export class PgStorage implements StorageProvider {
  constructor(private readonly db: Db) {}
  private tenantOf(key: string): string {
    const m = KEY.exec(key);
    if (!m || key.includes("..") || key.includes("//")) throw new Error("chave inválida");
    return m[1]!;
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const tenantId = this.tenantOf(key);
    await this.db.system(async (q) => { await q.query("insert into file_blobs (key, tenant_id, bytes) values ($1,$2,$3) on conflict (key) do nothing", [key, tenantId, Buffer.from(bytes)]); });
  }
  async get(key: string): Promise<Uint8Array | null> {
    this.tenantOf(key);
    const row = await this.db.system((q) => q.one<{ bytes: Buffer }>("select bytes from file_blobs where key = $1", [key]));
    return row ? new Uint8Array(row.bytes) : null;
  }
}
