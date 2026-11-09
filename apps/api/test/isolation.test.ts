import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client, type Harness, type SeededTenant, loginOwner, makeHarness, ownerSql, seedTenant } from "./harness";

let h: Harness;
let A: SeededTenant;
let B: SeededTenant;
let ca: Client;
let cb: Client;

beforeAll(async () => {
  h = makeHarness();
  A = await seedTenant(h);
  B = await seedTenant(h);
  ca = await loginOwner(h, A, "10.1.0.1");
  cb = await loginOwner(h, B, "10.1.0.2");
});
afterAll(async () => h.db.close());

describe("RLS — meta-teste", () => {
  it("toda tabela do schema public tem RLS ligada e FORÇADA, exceto as permitidas explicitamente", async () => {
    const rows = await ownerSql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c
         join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`,
    );
    // Sem RLS por desenho: acesso é sempre mediado por consultas de autenticação (ver SECURITY.md §RLS).
    const allowed = new Set(["users", "platform_users", "sessions", "auth_tokens", "rate_limits", "schema_migrations"]);
    const bad = rows.filter((r) => !allowed.has(r.relname) && !(r.relrowsecurity && r.relforcerowsecurity)).map((r) => r.relname);
    expect(bad).toEqual([]);
  });

  it("toda tabela com tenant_id está sob RLS (nenhuma exceção silenciosa)", async () => {
    const rows = await ownerSql<{ table_name: string; rls: boolean }>(
      `select c.relname as table_name, (c.relrowsecurity and c.relforcerowsecurity) as rls
         from information_schema.columns col join pg_class c on c.relname = col.table_name
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        where col.table_schema = 'public' and col.column_name = 'tenant_id' and c.relkind = 'r'`,
    );
    const exceptions = new Set(["sessions", "auth_tokens"]);
    expect(rows.filter((r) => !r.rls && !exceptions.has(r.table_name)).map((r) => r.table_name)).toEqual([]);
  });

  it("app_rw não é superusuário, não ignora RLS e não é dono das tabelas", async () => {
    const r = await ownerSql<{ rolsuper: boolean; rolbypassrls: boolean }>("select rolsuper, rolbypassrls from pg_roles where rolname = 'app_rw'");
    expect(r[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const own = await ownerSql("select 1 from pg_tables where schemaname = 'public' and tableowner = 'app_rw'");
    expect(own).toHaveLength(0);
  });

  it("sem contexto, app_rw não enxerga nenhuma linha de tabelas de tenant", async () => {
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try {
      for (const t of ["tenants", "units", "memberships", "subscriptions", "audit_log"]) {
        const r = await c.query(`select count(*)::int as n from ${t}`);
        expect(r.rows[0].n, t).toBe(0);
      }
    } finally {
      await c.end();
    }
  });

  it("app_rw não consegue UPDATE/DELETE em audit_log (append-only)", async () => {
    const t = await ownerSql("select 1 from audit_log limit 1");
    expect(t.length).toBeGreaterThan(0);
    await expect(
      h.db.tx({ actor: "platform" }, (q) => q.query("delete from audit_log")),
    ).rejects.toThrow();
    await expect(
      h.db.tx({ actor: "platform" }, (q) => q.query("update audit_log set action = 'x'")),
    ).rejects.toThrow();
  });
});

describe("Isolamento A × B", () => {
  it("A só lista as próprias unidades; B só as dele", async () => {
    const ra = await ca.get("/units");
    const rb = await cb.get("/units");
    expect(ra.json.units.map((u: any) => u.id).sort()).toEqual([...A.unitIds].sort());
    expect(rb.json.units.map((u: any) => u.id).sort()).toEqual([...B.unitIds].sort());
  });

  it("consulta direta por id de outro tenant, no nível do banco, não retorna nada", async () => {
    const rows = await h.db.tx({ actor: "tenant", tenantId: A.tenantId, userId: A.owners.userId, unitScope: "all" }, (q) =>
      q.many("select id from units where id = any($1::uuid[])", [B.unitIds]),
    );
    expect(rows).toHaveLength(0);
  });

  it("A não consegue inserir linha com tenant_id de B (WITH CHECK)", async () => {
    await expect(
      h.db.tx({ actor: "tenant", tenantId: A.tenantId, userId: A.owners.userId, unitScope: "all" }, (q) =>
        q.query("insert into units (tenant_id, name, code) values ($1,'x','HACK')", [B.tenantId]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("A não consegue atualizar/apagar unidade de B (0 linhas afetadas)", async () => {
    const r = await h.db.tx({ actor: "tenant", tenantId: A.tenantId, userId: A.owners.userId, unitScope: "all" }, async (q) => {
      const u = await q.query("update units set name = 'hacked' where id = any($1::uuid[])", [B.unitIds]);
      return u.rowCount;
    });
    expect(r).toBe(0);
    // DELETE em units nem é concedido a app_rw (privilégio mínimo)
    await expect(
      h.db.tx({ actor: "tenant", tenantId: A.tenantId, userId: A.owners.userId, unitScope: "all" }, (q) =>
        q.query("delete from units where id = any($1::uuid[])", [B.unitIds]),
      ),
    ).rejects.toThrow(/permission denied/);
    const sm = await ownerSql("select has_table_privilege('app_rw','schema_migrations','select') as p");
    expect(sm[0].p).toBe(false);
    const still = await ownerSql("select name from units where id = any($1::uuid[])", [B.unitIds]);
    expect(still.every((x: any) => x.name !== "hacked")).toBe(true);
  });

  it("composite FK impede vincular membership de A à unidade de B", async () => {
    const m = await ownerSql<{ id: string }>("select id from memberships where tenant_id = $1", [A.tenantId]);
    await expect(
      ownerSql("insert into unit_memberships (tenant_id, membership_id, unit_id) values ($1,$2,$3)", [A.tenantId, m[0]!.id, B.unitIds[0]]),
    ).rejects.toThrow(/foreign key/);
  });

  it("convite com unitId de outro tenant falha", async () => {
    const r = await ca.post("/members/invite", { email: "x1@example.test", roleKey: "attendant", unitIds: [B.unitIds[0]] });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const leaked = await ownerSql("select 1 from users where email = 'x1@example.test'");
    expect(leaked).toHaveLength(0); // transação inteira reverteu
  });

  it("auditoria de A não contém eventos de B", async () => {
    await cb.post("/units", { name: "Só do B", code: "ONLYB" });
    const r = await ca.get("/audit");
    expect(r.status).toBe(200);
    expect(r.json.events.some((e: any) => e.entity_type === "unit" && e.actor_id === B.owners.userId)).toBe(false);
  });
});

describe("Escopo por unidade", () => {
  it("usuário restrito a uma unidade só enxerga essa unidade", async () => {
    // convida atendente restrito à unidade 0 de A e aceita convite
    const inv = await ca.post("/members/invite", { email: `att-${A.slug}@example.test`, roleKey: "attendant", unitIds: [A.unitIds[0]] });
    expect(inv.status).toBe(201);
    const acc = await new Client(h, "10.1.0.9").post("/auth/invite/accept", { token: inv.json.devToken, password: "Outra-Senha-456!" });
    expect(acc.status).toBe(200);
    const att = new Client(h, "10.1.0.9");
    const lg = await att.post("/auth/login", { email: `att-${A.slug}@example.test`, password: "Outra-Senha-456!", tenantSlug: A.slug });
    expect(lg.status).toBe(200);
    const me = await att.get("/auth/me");
    expect(me.json.unitScope).toBe("list");
    // atendente não tem units:read? verifica pelo banco com o mesmo contexto
    const seen = await h.db.tx(
      { actor: "tenant", tenantId: A.tenantId, userId: me.json.userId, unitScope: "list", unitIds: me.json.unitIds },
      (q) => q.many<{ id: string }>("select id from units"),
    );
    expect(seen.map((x) => x.id)).toEqual([A.unitIds[0]]);
  });

  it("escopo 'list' sem unidades não enxerga nenhuma (falha fechada)", async () => {
    const seen = await h.db.tx({ actor: "tenant", tenantId: A.tenantId, userId: A.owners.userId, unitScope: "list", unitIds: [] }, (q) =>
      q.many("select id from units"),
    );
    expect(seen).toHaveLength(0);
  });
});
