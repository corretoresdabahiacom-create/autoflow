import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, type SeededTenant, PW, freshCode, loginOwner, makeHarness, ownerSql, seedTenant } from "./harness";
import { newTotpSecret, totpAtStep, totpStepNow, encryptSecret } from "../src/crypto";
import { lockMinutes } from "../src/authcore";

let h: Harness;
let T: SeededTenant;
beforeAll(async () => {
  h = makeHarness();
  T = await seedTenant(h);
});
afterAll(async () => h.db.close());

describe("login / logout", () => {
  it("login ok → /auth/me → logout invalida a sessão", async () => {
    const c = await loginOwner(h, T, "10.2.0.1");
    expect((await c.get("/auth/me")).status).toBe(200);
    expect((await c.post("/auth/logout")).status).toBe(200);
    expect((await c.get("/auth/me")).status).toBe(401);
  });

  it("cookie de sessão é HttpOnly e SameSite=Lax; token não é guardado em claro", async () => {
    const c = new Client(h, "10.2.0.2");
    const res = await h.app.request("/auth/login", {
      method: "POST",
      headers: { origin: "http://localhost:5173", "content-type": "application/json", "x-real-ip": "10.2.0.2" },
      body: JSON.stringify({ email: T.owners.email, password: PW, tenantSlug: T.slug }),
    });
    const sc = res.headers.getSetCookie()[0]!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    const token = sc.split(";")[0]!.split("=")[1]!;
    const rows = await ownerSql("select 1 from sessions where token_hash = $1", [token]);
    expect(rows).toHaveLength(0);
    void c;
  });

  it("credenciais erradas, usuário inexistente e tenant errado dão a mesma resposta", async () => {
    const c = new Client(h, "10.2.0.3");
    const a = await c.post("/auth/login", { email: T.owners.email, password: "errada-errada-1", tenantSlug: T.slug });
    const b = await c.post("/auth/login", { email: "nao-existe@example.test", password: PW, tenantSlug: T.slug });
    const d = await c.post("/auth/login", { email: T.owners.email, password: PW, tenantSlug: "outro-tenant-xx" });
    for (const r of [a, b, d]) {
      expect(r.status).toBe(401);
      expect(r.json.error).toBe("invalid_credentials");
    }
  });

  it("mutação sem Origin permitida é rejeitada (CSRF)", async () => {
    const c = new Client(h, "10.2.0.4");
    expect((await c.req("POST", "/auth/login", {}, { origin: null })).status).toBe(403);
    expect((await c.req("POST", "/auth/login", {}, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("sessão expirada por inatividade e por tempo absoluto é recusada", async () => {
    const c = await loginOwner(h, T, "10.2.0.5");
    await ownerSql("update sessions set idle_expires_at = now() - interval '1 second' where user_id = $1 and revoked_at is null", [T.owners.userId]);
    expect((await c.get("/auth/me")).status).toBe(401);
    const c2 = await loginOwner(h, T, "10.2.0.5");
    await ownerSql("update sessions set absolute_expires_at = now() - interval '1 second' where user_id = $1 and revoked_at is null", [T.owners.userId]);
    expect((await c2.get("/auth/me")).status).toBe(401);
  });
});

describe("lockout e rate limit", () => {
  it("lockMinutes é progressivo e limitado a 24h", () => {
    expect([0, 4, 5, 6, 7].map(lockMinutes)).toEqual([0, 0, 1, 2, 4]);
    expect(lockMinutes(100)).toBe(1440);
  });

  it("5 falhas bloqueiam a conta; senha correta é recusada durante o bloqueio", async () => {
    const t = await seedTenant(h);
    for (let i = 0; i < 5; i++) {
      const c = new Client(h, `10.3.${i}.1`);
      await c.post("/auth/login", { email: t.owners.email, password: "errada-errada-1", tenantSlug: t.slug });
    }
    const c = new Client(h, "10.3.9.9");
    const r = await c.post("/auth/login", { email: t.owners.email, password: PW, tenantSlug: t.slug });
    expect(r.status).toBe(429);
    expect(r.json.error).toBe("account_locked");
    expect(r.headers.get("retry-after")).toBeTruthy();
    // desbloqueio por expiração
    await ownerSql("update users set locked_until = now() - interval '1 second' where id = $1", [t.owners.userId]);
    expect((await c.post("/auth/login", { email: t.owners.email, password: PW, tenantSlug: t.slug })).status).toBe(200);
  });

  it("rate limit por IP devolve 429 com Retry-After", async () => {
    const c = new Client(h, "10.4.0.1");
    let last = 0;
    for (let i = 0; i < 35; i++) {
      last = (await c.post("/auth/login", { email: `x${i}@example.test`, password: "qualquer-senha-1", tenantSlug: T.slug })).status;
    }
    expect(last).toBe(429);
  });
});

describe("convite e reset de senha", () => {
  it("convite: token de uso único, senha fraca recusada", async () => {
    const owner = await loginOwner(h, T, "10.5.0.1");
    const inv = await owner.post("/members/invite", { email: `inv-${T.slug}@example.test`, roleKey: "manager", allUnits: true });
    expect(inv.status).toBe(201);
    const c = new Client(h, "10.5.0.2");
    expect((await c.post("/auth/invite/accept", { token: inv.json.devToken, password: "curta" })).status).toBe(422);
    expect((await c.post("/auth/invite/accept", { token: inv.json.devToken, password: "Outra-Senha-456!" })).status).toBe(200);
    expect((await c.post("/auth/invite/accept", { token: inv.json.devToken, password: "Outra-Senha-456!" })).status).toBe(400);
    expect(h.email.sent.some((m) => m.template === "invite")).toBe(true);
  });

  it("convite expirado é recusado", async () => {
    const owner = await loginOwner(h, T, "10.5.0.3");
    const inv = await owner.post("/members/invite", { email: `exp-${T.slug}@example.test`, roleKey: "manager", allUnits: true });
    await ownerSql("update auth_tokens set expires_at = now() - interval '1 minute' where kind = 'invite' and used_at is null");
    const r = await new Client(h, "10.5.0.4").post("/auth/invite/accept", { token: inv.json.devToken, password: "Outra-Senha-456!" });
    expect(r.status).toBe(400);
  });

  it("reset: resposta uniforme, token único, invalida sessões, tokens não ficam em claro", async () => {
    const t = await seedTenant(h);
    const sess = await loginOwner(h, t, "10.6.0.1");
    const anon = new Client(h, "10.6.0.2");
    const ghost = await anon.post("/auth/password/forgot", { email: "ninguem@example.test", tenantSlug: t.slug });
    const real = await anon.post("/auth/password/forgot", { email: t.owners.email, tenantSlug: t.slug });
    expect(ghost.status).toBe(202);
    expect(real.status).toBe(202);
    expect(ghost.json.devToken).toBeUndefined();
    const token = real.json.devToken as string;
    expect(await ownerSql("select 1 from auth_tokens where token_hash = $1", [token])).toHaveLength(0);
    const novo = "Nova-Senha-789!x";
    expect((await anon.post("/auth/password/reset", { token, password: novo })).status).toBe(200);
    expect((await anon.post("/auth/password/reset", { token, password: novo })).status).toBe(400);
    expect((await sess.get("/auth/me")).status).toBe(401); // sessão antiga revogada
    const c = new Client(h, "10.6.0.3");
    expect((await c.post("/auth/login", { email: t.owners.email, password: novo, tenantSlug: t.slug })).status).toBe(200);
    expect((await c.post("/auth/login", { email: t.owners.email, password: PW, tenantSlug: t.slug })).status).toBe(401);
  });
});

describe("MFA de usuário de tenant", () => {
  it("após ativar, login exige código; replay do mesmo código é recusado", async () => {
    const t = await seedTenant(h);
    const c = await loginOwner(h, t, "10.7.0.1");
    const en = await c.post("/auth/mfa/enroll");
    expect(en.status).toBe(200);
    const secret = en.json.secret as string;
    expect((await c.post("/auth/mfa/confirm", { code: await totpAtStep(secret, totpStepNow()) })).status).toBe(200);

    const c2 = new Client(h, "10.7.0.2");
    const body = { email: t.owners.email, password: PW, tenantSlug: t.slug };
    expect((await c2.post("/auth/login", body)).json.error).toBe("mfa_required");
    const code = await freshCode("users", t.owners.userId, secret);
    expect((await c2.post("/auth/login", { ...body, mfaCode: code })).status).toBe(200);
    const c3 = new Client(h, "10.7.0.3");
    expect((await c3.post("/auth/login", { ...body, mfaCode: code })).status).toBe(401); // replay
    expect((await c3.post("/auth/login", { ...body, mfaCode: "000000" })).status).toBe(401);
  });
});

describe("hash de senha", () => {
  it("hash não contém a senha e usa parâmetros embutidos", async () => {
    const r = await ownerSql<{ password_hash: string }>("select password_hash from users where id = $1", [T.owners.userId]);
    expect(r[0]!.password_hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/);
    expect(r[0]!.password_hash).not.toContain(PW);
  });
  void newTotpSecret; void encryptSecret;
});
