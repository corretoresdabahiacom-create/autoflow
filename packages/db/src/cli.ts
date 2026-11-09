import { bootstrap } from "./bootstrap";
import { migrate } from "./migrate";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente ausente: ${name}`);
  return v;
}

const cmd = process.argv[2];

if (cmd === "bootstrap") {
  if (process.env.NODE_ENV === "production") throw new Error("bootstrap não deve rodar em produção por este comando");
  await bootstrap({
    superUrl: need("AF_SUPERUSER_URL"),
    database: process.env.AF_DB_NAME ?? "autoflow",
    ownerPassword: process.env.AF_OWNER_PASSWORD ?? "app_owner_dev",
    rwPassword: process.env.AF_RW_PASSWORD ?? "app_rw_dev",
    reset: process.argv.includes("--reset"),
  });
  console.log("bootstrap ok");
} else if (cmd === "migrate") {
  const applied = await migrate(need("MIGRATION_DATABASE_URL"));
  console.log(applied.length ? `aplicadas: ${applied.join(", ")}` : "nada a aplicar");
} else {
  console.error("uso: cli bootstrap [--reset] | migrate");
  process.exit(1);
}
