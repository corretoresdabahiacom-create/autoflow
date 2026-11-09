import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, PW, freshCode, loginOwner, makeHarness, ownerSql, seedPlatformUser, seedTenant } from "./harness";

let h: Harness;
beforeAll(() => {
  h = makeHarness();
});
afterAll(async () => h.db.close());

async function member(t: Awaited<ReturnType<typeof seedTenant>>, owner: Client, roleKey: string, ip: string) {
  const email = `${roleKey}-${t.slug}@example.test`;
  const inv = await owner.post("/members/invite", { email, roleKey, allUnits: true });
  expect(inv.status).toBe(201);
  const c = new Client(h, ip);
  await c.post("/auth/invite/accept", { token: inv.json.devToken, password: "Outra-Senha-456!" });
  expect((await c.post("/auth/login", { email, password: "Outra-Senha-456!", tenantSlug: t.slug })).status).toBe(200);
  return { c, membershipId: inv.json.membershipId as string };
}

describe("RBAC e anti-escalada", () => {
  it("rota exige permissão: mecânico não lista membros nem convida", async () => {
    const t = await seedTenant(h);
    const owner = await loginOwner(h, t, "10.10.0.1");
    const { c } = await member(t, owner, "mechanic", "10.10.0.2");
    expect((await c.get("/members")).json.error).toBe("permission_denied");
    expect((await c.post("/members/invite", { email: "z@example.test", roleKey: "mechanic", allUnits: true })).status).toBe(403);
  });

  it("admin não concede papel com permissões que ele não tem (owner)", async () => {
    const t = await seedTenant(h);
    const owner = await loginOwner(h, t, "10.10.1.1");
    const { c } = await member(t, owner, "admin", "10.10.1.2");
    const r = await c.post("/members/invite", { email: "y@example.test", roleKey: "owner", allUnits: true });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("role_escalation");
  });

  it("não é possível rebaixar nem suspender o último proprietário", async () => {
    const t = await seedTenant(h);
    const owner = await loginOwner(h, t, "10.10.2.1");
    const m = await owner.get("/members");
    const id = m.json.members[0].id;
    expect((await owner.patch(`/members/${id}/role`, { roleKey: "admin" })).json.error).toBe("last_owner");
    expect((await owner.patch(`/members/${id}/status`, { status: "suspended" })).json.error).toBe("last_owner");
  });

  it("membro suspenso perde acesso imediatamente", async () => {
    const t = await seedTenant(h);
    const owner = await loginOwner(h, t, "10.10.3.1");
    const { c, membershipId } = await member(t, owner, "manager", "10.10.3.2");
    expect((await c.get("/auth/me")).status).toBe(200);
    expect((await owner.patch(`/members/${membershipId}/status`, { status: "suspended" })).status).toBe(200);
    expect((await c.get("/auth/me")).status).toBe(401);
  });
});

describe("Entitlements (backend)", () => {
  it("limite de unidades do plano é imposto pelo backend (403)", async () => {
    const t = await seedTenant(h, { plan: "ESSENCIAL", units: 1 });
    const owner = await loginOwner(h, t, "10.11.0.1");
    const lim = (await ownerSql<{ value: number }>(
      "select pf.value::text::int as value from plan_features pf join plans p on p.id = pf.plan_id where p.code = 'ESSENCIAL' and pf.feature_code = 'units.max'",
    ))[0]!.value;
    let status = 201;
    for (let i = 0; i < lim + 1 && status === 201; i++) {
      status = (await owner.post("/units", { name: `Nova ${i}`, code: `N${i}` })).status;
    }
    expect(status).toBe(403);
    expect((await owner.post("/units", { name: "Mais uma", code: "MAIS" })).json.error).toBe("limit_reached");
  });

  it("recurso ausente do plano é negado (falha fechada) — rota com feature inexistente", async () => {
    const { hasFeature, resolveEntitlements } = await import("@autoflow/shared");
    expect(hasFeature(resolveEntitlements({}, {}, "active"), "portal")).toBe(false);
  });

  it("tenant suspenso: API devolve 403; assinatura suspensa: 402/403", async () => {
    const t = await seedTenant(h);
    const owner = await loginOwner(h, t, "10.11.1.1");
    await ownerSql("update subscriptions set status = 'suspended' where tenant_id = $1", [t.tenantId]);
    expect([402, 403]).toContain((await owner.get("/units")).status);
    await ownerSql("update subscriptions set status = 'active' where tenant_id = $1", [t.tenantId]);
    await ownerSql("update tenants set status = 'suspended' where id = $1", [t.tenantId]);
    expect((await owner.get("/units")).status).toBe(403);
  });
});

describe("Registro de rotas", () => {
  it("toda rota registrada no Hono possui política declarada (e vice-versa)", () => {
    const declared = new Set(h.registry.map((r) => `${r.method} ${r.path}`));
    const actual = new Set(
      (h.app.routes as { method: string; path: string }[])
        .filter((r) => r.method !== "ALL")
        .map((r) => `${r.method} ${r.path}`),
    );
    const undeclared = [...actual].filter((x) => !declared.has(x));
    expect(undeclared).toEqual([]);
    expect([...declared].filter((x) => !actual.has(x))).toEqual([]);
  });

  it("rotas protegidas respondem 401 sem sessão", async () => {
    const c = new Client(h, "10.12.0.1");
    for (const r of h.registry.filter((x) => x.policy.auth !== "public")) {
      const path = r.path.replace(/:[a-zA-Z]+/g, "00000000-0000-4000-8000-000000000000");
      const res = await c.req(r.method, path, r.method === "GET" ? undefined : {});
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
    }
  });
});

async function platformLogin(user: { email: string; secret: string; id: string }, ip: string) {
  const c = new Client(h, ip);
  expect((await c.post("/platform/auth/login", { email: user.email, password: PW })).status).toBe(200);
  expect((await c.post("/platform/auth/mfa/verify", { code: await freshCode("platform_users", user.id, user.secret) })).status).toBe(200);
  return c;
}

describe("Super Admin", () => {
  it("sem MFA verificado, rotas do Super Admin são negadas", async () => {
    const u = await seedPlatformUser(h);
    const c = new Client(h, "10.13.0.1");
    await c.post("/platform/auth/login", { email: u.email, password: PW });
    expect((await c.get("/platform/tenants")).json.error).toBe("mfa_required");
    expect((await c.post("/platform/auth/mfa/verify", { code: "000000" })).status).toBe(401);
    expect((await c.get("/platform/tenants")).status).toBe(403);
  });

  it("sessão de tenant não abre rotas de plataforma e vice-versa", async () => {
    const t = await seedTenant(h);
    const owner = await loginOwner(h, t, "10.13.1.1");
    expect((await owner.get("/platform/tenants")).status).toBe(401);
    const u = await seedPlatformUser(h);
    const sa = await platformLogin(u, "10.13.1.2");
    expect((await sa.get("/units")).status).toBe(401);
  });

  it("provisiona tenant, bloqueia (revoga sessões) e reativa — tudo auditado", async () => {
    const u = await seedPlatformUser(h);
    const sa = await platformLogin(u, "10.13.2.1");
    const slug = `prov${Date.now().toString(36)}`;
    const p = await sa.post("/platform/tenants", { name: "Oficina Nova", slug, planCode: "PROFISSIONAL", ownerEmail: `${slug}@example.test` });
    expect(p.status).toBe(201);
    expect((await sa.post("/platform/tenants", { name: "Outra", slug: "admin", planCode: "PROFISSIONAL", ownerEmail: "q@example.test" })).status).toBe(422);
    expect((await sa.post("/platform/tenants", { name: "Dup", slug, planCode: "PROFISSIONAL", ownerEmail: "q2@example.test" })).status).toBe(409);
    const ow = new Client(h, "10.13.2.2");
    await ow.post("/auth/invite/accept", { token: p.json.devToken, password: "Outra-Senha-456!" });
    expect((await ow.post("/auth/login", { email: `${slug}@example.test`, password: "Outra-Senha-456!", tenantSlug: slug })).status).toBe(200);
    const id = p.json.tenantId;
    expect((await sa.post(`/platform/tenants/${id}/block`, { reason: "inadimplência" })).status).toBe(200);
    expect((await ow.get("/auth/me")).status).toBe(401);
    expect((await sa.post(`/platform/tenants/${id}/reactivate`, { reason: "regularizado ok" })).status).toBe(200);
    const acts = await ownerSql<{ action: string }>("select action from audit_log where tenant_id = $1", [id]);
    expect(acts.map((a) => a.action)).toEqual(expect.arrayContaining(["tenant.provision", "tenant.block", "tenant.reactivate"]));
  });

  it("MFA recente: ação sensível exige reautenticação após o prazo", async () => {
    const u = await seedPlatformUser(h);
    const sa = await platformLogin(u, "10.13.3.1");
    await ownerSql("update sessions set mfa_verified_at = now() - interval '2 hours' where platform_user_id = $1", [u.id]);
    expect((await sa.get("/platform/tenants")).status).toBe(200); // leitura: MFA verificado basta
    const r = await sa.post("/platform/support/grants", { tenantId: "00000000-0000-4000-8000-000000000000", reason: "investigar chamado 123", scope: ["units"], minutes: 30 });
    expect(r.json.error).toBe("mfa_recent_required");
  });

  it("Super Admin NÃO lê dados internos do tenant sem grant", async () => {
    const t = await seedTenant(h);
    const rows = await h.db.tx({ actor: "platform" }, async (q) => ({
      units: await q.many("select id from units"),
      members: await q.many("select id from memberships"),
    }));
    expect(rows.units).toHaveLength(0);
    expect(rows.members).toHaveLength(0);
    void t;
  });
});

describe("Acesso excepcional (grant)", () => {
  async function setup() {
    const t = await seedTenant(h);
    const u = await seedPlatformUser(h);
    const sa = await platformLogin(u, "10.14.0." + Math.floor(Math.random() * 200 + 1));
    return { t, u, sa };
  }

  it("sem grant: negado; com grant: lê só o escopo, auditado; fora do escopo: negado", async () => {
    const { t, sa } = await setup();
    const bogus = "00000000-0000-4000-8000-000000000001";
    expect((await sa.get(`/platform/support/${bogus}/units`)).status).toBe(403);

    const g = await sa.post("/platform/support/grants", { tenantId: t.tenantId, reason: "investigar chamado 123", scope: ["units"], minutes: 30 });
    expect(g.status).toBe(201);
    const ok = await sa.get(`/platform/support/${g.json.id}/units`);
    expect(ok.status).toBe(200);
    expect(ok.json.rows.map((r: any) => r.id).sort()).toEqual([...t.unitIds].sort());
    expect((await sa.get(`/platform/support/${g.json.id}/members`)).json.rows ?? []).toHaveLength(0); // fora do escopo: RLS esconde
    const evs = await ownerSql("select 1 from audit_log where tenant_id = $1 and action = 'support.read'", [t.tenantId]);
    expect(evs.length).toBeGreaterThan(0);
  });

  it("grant expirado ou revogado deixa de funcionar", async () => {
    const { t, sa } = await setup();
    const g = await sa.post("/platform/support/grants", { tenantId: t.tenantId, reason: "investigar chamado 456", scope: ["units"], minutes: 30 });
    await ownerSql("update support_access_grants set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where id = $1", [g.json.id]);
    expect((await sa.get(`/platform/support/${g.json.id}/units`)).json.rows ?? []).toHaveLength(0);
    const g2 = await sa.post("/platform/support/grants", { tenantId: t.tenantId, reason: "investigar chamado 789", scope: ["units"], minutes: 30 });
    expect((await sa.get(`/platform/support/${g2.json.id}/units`)).json.rows).toHaveLength(t.unitIds.length);
    expect((await sa.post(`/platform/support/grants/${g2.json.id}/revoke`)).status).toBe(200);
    expect((await sa.get(`/platform/support/${g2.json.id}/units`)).json.rows ?? []).toHaveLength(0);
  });

  it("grant é limitado a 4h, exige motivo e é somente leitura no banco", async () => {
    const { t, sa } = await setup();
    expect((await sa.post("/platform/support/grants", { tenantId: t.tenantId, reason: "curto", scope: ["units"], minutes: 30 })).status).toBe(422);
    expect((await sa.post("/platform/support/grants", { tenantId: t.tenantId, reason: "investigar chamado 123", scope: ["units"], minutes: 600 })).status).toBe(422);
    const g = await sa.post("/platform/support/grants", { tenantId: t.tenantId, reason: "investigar chamado 321", scope: ["units"], minutes: 30 });
    const u = await ownerSql<{ id: string }>("select operator_id as id from support_access_grants where id = $1", [g.json.id]);
    await expect(
      h.db.tx({ actor: "support", tenantId: t.tenantId, userId: u[0]!.id, grantId: g.json.id, readonly: true, unitScope: "all" }, (q) =>
        q.query("update units set name = 'hack' where tenant_id = $1", [t.tenantId]),
      ),
    ).resolves.toBeDefined();
    const after = await ownerSql("select name from units where tenant_id = $1", [t.tenantId]);
    expect(after.every((r: any) => r.name !== "hack")).toBe(true);
  });

  it("grant de um tenant não dá acesso a outro tenant", async () => {
    const { t, sa } = await setup();
    const other = await seedTenant(h);
    const g = await sa.post("/platform/support/grants", { tenantId: t.tenantId, reason: "investigar chamado 654", scope: ["units"], minutes: 30 });
    const u = await ownerSql<{ id: string }>("select operator_id as id from support_access_grants where id = $1", [g.json.id]);
    const rows = await h.db.tx({ actor: "support", tenantId: other.tenantId, userId: u[0]!.id, grantId: g.json.id, readonly: true, unitScope: "all" }, (q) =>
      q.many("select id from units"),
    );
    expect(rows).toHaveLength(0);
  });
});
