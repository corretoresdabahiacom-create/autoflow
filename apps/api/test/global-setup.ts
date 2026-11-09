import { bootstrap, migrate } from "@autoflow/db";

const SUPER = process.env.TEST_SUPERUSER_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const DBNAME = "autoflow_test";

function url(user: string, pw: string): string {
  const u = new URL(SUPER);
  u.username = user;
  u.password = pw;
  u.pathname = `/${DBNAME}`;
  return u.toString();
}

/** Banco EXCLUSIVO de teste (autoflow_test), recriado a cada execução. Nunca toca o banco de desenvolvimento. */
export default async function setup(): Promise<void> {
  await bootstrap({ superUrl: SUPER, database: DBNAME, ownerPassword: "app_owner_dev", rwPassword: "app_rw_dev", reset: true });
  await migrate(url("app_owner", "app_owner_dev"));
  process.env.TEST_DATABASE_URL = url("app_rw", "app_rw_dev");
  // Fixtures de teste usam superusuário (ignora RLS FORCE); a aplicação sempre usa app_rw.
  const su = new URL(SUPER);
  su.pathname = `/${DBNAME}`;
  process.env.TEST_OWNER_URL = su.toString();
}
