import pg from "pg";

export interface BootstrapOptions {
  /** URL de superusuário (apenas para criar roles/banco; nunca usada pela aplicação). */
  superUrl: string;
  database?: string;
  ownerPassword: string;
  rwPassword: string;
  /** DESTRUTIVO: derruba e recria o banco. Só para ambientes de teste/desenvolvimento. */
  reset?: boolean;
}

const IDENT = /^[a-z][a-z0-9_]{0,62}$/;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * Cria (idempotente) as roles app_owner (DDL/migrations) e app_rw (aplicação: sem BYPASSRLS,
 * sem DDL), o banco e a extensão citext.
 */
export async function bootstrap(opts: BootstrapOptions): Promise<void> {
  const database = opts.database ?? "autoflow";
  if (!IDENT.test(database)) throw new Error("Nome de banco inválido");

  const admin = new pg.Client({ connectionString: withDatabase(opts.superUrl, "postgres") });
  await admin.connect();
  try {
    const lit = (s: string) => admin.escapeLiteral(s);
    const db = admin.escapeIdentifier(database);

    for (const [role, pw, attrs] of [
      ["app_owner", opts.ownerPassword, "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"],
      ["app_rw", opts.rwPassword, "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"],
    ] as const) {
      const exists = await admin.query("select 1 from pg_roles where rolname = $1", [role]);
      if (exists.rowCount) await admin.query(`alter role ${role} with ${attrs} password ${lit(pw)}`);
      else await admin.query(`create role ${role} with ${attrs} password ${lit(pw)}`);
    }

    if (opts.reset) {
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [database],
      );
      await admin.query(`drop database if exists ${db}`);
    }
    const dbExists = await admin.query("select 1 from pg_database where datname = $1", [database]);
    if (!dbExists.rowCount) await admin.query(`create database ${db} owner app_owner`);
    await admin.query(`revoke all on database ${db} from public`);
    await admin.query(`grant connect on database ${db} to app_owner, app_rw`);
  } finally {
    await admin.end();
  }

  const inDb = new pg.Client({ connectionString: withDatabase(opts.superUrl, database) });
  await inDb.connect();
  try {
    await inDb.query("create extension if not exists citext");
    await inDb.query("create extension if not exists pg_trgm");
    await inDb.query("revoke create on schema public from public");
    await inDb.query("grant all on schema public to app_owner");
  } finally {
    await inDb.end();
  }
}
