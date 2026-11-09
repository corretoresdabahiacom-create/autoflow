import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";

export type Actor = "tenant" | "platform" | "system" | "support";

/** Contexto transacional que alimenta a RLS (SET LOCAL). Definido apenas por esta camada. */
export interface DbContext {
  actor: Actor;
  tenantId?: string;
  userId?: string;
  grantId?: string;
  readonly?: boolean;
  unitScope?: "all" | "list";
  unitIds?: readonly string[];
}

export interface Q {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
  one<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<R | null>;
  many<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<R[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuid(v: string, what = "id"): string {
  if (!UUID.test(v)) throw new Error(`${what} inválido`);
  return v;
}

export class Db {
  readonly pool: pg.Pool;

  constructor(connectionString: string, max = 10) {
    this.pool = new pg.Pool({ connectionString, max });
  }

  /**
   * Única porta de acesso a dados de aplicação. Abre transação, fixa o contexto de RLS
   * com SET LOCAL (escopo da transação) e executa `fn`. Qualquer erro faz rollback.
   */
  async tx<T>(ctx: DbContext, fn: (q: Q) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const unitIds = ctx.unitIds?.map((u) => assertUuid(u, "unitId")).join(",") ?? "";
      await client.query(
        `select set_config('app.actor', $1, true), set_config('app.tenant_id', $2, true),
                set_config('app.user_id', $3, true), set_config('app.grant_id', $4, true),
                set_config('app.readonly', $5, true), set_config('app.unit_scope', $6, true),
                set_config('app.unit_ids', $7, true)`,
        [
          ctx.actor,
          ctx.tenantId ? assertUuid(ctx.tenantId, "tenantId") : "",
          ctx.userId ? assertUuid(ctx.userId, "userId") : "",
          ctx.grantId ? assertUuid(ctx.grantId, "grantId") : "",
          ctx.readonly ? "on" : "off",
          ctx.unitScope ?? "",
          unitIds,
        ],
      );
      const q: Q = {
        query: (text, params) => client.query(text, params as unknown[]),
        one: async (text, params) => (await client.query(text, params as unknown[])).rows[0] ?? null,
        many: async (text, params) => (await client.query(text, params as unknown[])).rows,
      };
      const result = await fn(q);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  system<T>(fn: (q: Q) => Promise<T>, userId?: string): Promise<T> {
    return this.tx({ actor: "system", userId }, fn);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
