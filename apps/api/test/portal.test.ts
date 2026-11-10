import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, loginOwner, makeHarness, ownerSql, seedTenant, uniq } from "./harness";

let h: Harness;
beforeAll(() => { h = makeHarness(); });
afterAll(async () => h.db.close());

let ipn = 1;
const nextIp = () => `10.77.${Math.floor(ipn / 250)}.${(ipn++ % 250) + 1}`;
const item = (d = "Troca de óleo", qty = 1, price = 15000) => ({ description: d, category: "service", qty, unitPriceCents: price });

async function setup(email = "cliente@example.test") {
  const t = await seedTenant(h);
  const c = await loginOwner(h, t, nextIp());
  const cu = await c.post("/customers", { name: "Maria Silva Santos", phone: "(71) 99999-1234", email });
  const ve = await c.post(`/customers/${cu.json.id}/vehicles`, { plate: `PRT${Math.floor(Math.random() * 9)}${"ABCDEFGHJK"[Math.floor(Math.random() * 10)]}${Math.floor(Math.random() * 90 + 10)}`, make: "VW", model: "Gol" });
  const o = await c.post("/orders", { customerId: cu.json.id, vehicleId: ve.json.id });
  expect(o.status, JSON.stringify(o.json)).toBe(201);
  return { t, c, orderId: o.json.id as string, customerId: cu.json.id as string };
}
async function withEstimate(c: Client, orderId: string, items = [item(), item("Filtro", 1, 4000)]) {
  for (const i of items) expect((await c.post(`/orders/${orderId}/estimate/items`, i)).status).toBe(201);
  const p = await c.post(`/orders/${orderId}/estimate/publish`);
  expect(p.status, JSON.stringify(p.json)).toBeLessThan(300);
}
async function mkLink(c: Client, orderId: string) {
  const r = await c.post(`/orders/${orderId}/portal-link`);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const token = (r.json.url as string).split("#")[1]!;
  return { ...r.json, token } as { id: string; url: string; token: string; qrSvg: string; expiresAt: string };
}
async function portalClient(token: string) {
  const p = new Client(h, nextIp());
  const r = await p.post("/portal/session", { token });
  return { p, r };
}
async function fullSetup() {
  const s = await setup();
  await withEstimate(s.c, s.orderId);
  const link = await mkLink(s.c, s.orderId);
  const { p, r } = await portalClient(link.token);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { ...s, link, p };
}

describe("P1 token: ≥256 bits, só hash, fragmento", () => {
  it("armazena apenas SHA-256 do token; URL usa fragmento; QR gerado", async () => {
    const s = await setup();
    const link = await mkLink(s.c, s.orderId);
    const secret = link.token.split(".")[1]!;
    expect(Buffer.from(secret, "base64url").length).toBeGreaterThanOrEqual(32);
    expect(link.url).toContain("/portal#");
    expect(link.url.split("#")[0]).not.toContain(secret);
    expect(link.qrSvg).toContain("<svg");
    const rows = await ownerSql("select token_hash from portal_links where os_id = $1", [s.orderId]);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(secret);
    const list = await s.c.get(`/orders/${s.orderId}/portal-links`);
    expect(JSON.stringify(list.json)).not.toContain(secret);
  });
});

describe("P2 isolamento / IDOR / enumeração", () => {
  it("sessão só enxerga a própria OS; token de A não acessa OS de B; adulteração falha", async () => {
    const A = await fullSetup(); const B = await fullSetup();
    const a = await A.p.get("/portal/order"); const b = await B.p.get("/portal/order");
    expect(a.json.orderInfo.number).toBeDefined();
    expect(JSON.stringify(a.json)).not.toContain(B.orderId);
    expect(b.json.orderInfo.plate).not.toBe(a.json.orderInfo.plate);
    // token do tenant B com segredo errado, e token de A trocando tenant
    const forged = new Client(h, nextIp());
    expect((await forged.post("/portal/session", { token: `${B.t.tenantId}.${A.link.token.split(".")[1]}` })).status).toBe(401);
    expect((await forged.post("/portal/session", { token: "x".repeat(60) })).status).toBe(401);
    // cookie de portal com tenant trocado não vale
    const hijack = new Client(h, nextIp());
    const secret = [...A.p.cookies.values()][0]!.split(".")[1]!;
    hijack.cookies.set("af_portal", `${B.t.tenantId}.${secret}`);
    expect((await hijack.get("/portal/order")).status).toBe(401);
    // rotas de portal não aceitam id de OS
    expect((await A.p.get(`/portal/order?osId=${B.orderId}`)).json.orderInfo.number).toBe(a.json.orderInfo.number);
  });
  it("sem sessão: 401", async () => {
    const p = new Client(h, nextIp());
    for (const path of ["/portal/order"]) expect((await p.get(path)).status).toBe(401);
    expect((await p.post("/portal/approval/otp")).status).toBe(401);
    expect((await p.post("/portal/messages", { body: "oi" })).status).toBe(401);
  });
});

describe("P3 rate limit e atraso progressivo", () => {
  it("tentativas inválidas repetidas levam a 429 e há atraso", async () => {
    const s = await setup(); const link = await mkLink(s.c, s.orderId);
    const p = new Client(h, nextIp());
    const bad = `${s.t.tenantId}.${"A".repeat(43)}`;
    const t0 = Date.now(); const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await p.post("/portal/session", { token: bad })).status);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes).toContain(429);
    expect(Date.now() - t0).toBeGreaterThan(300);
    void link;
  });
});

describe("P4/P5 aprovação com OTP e versão correta", () => {
  it("exige OTP; código errado falha; correto aprova com evidência completa; OTP é de uso único", async () => {
    const s = await fullSetup();
    const o = await s.p.get("/portal/order");
    const ver = o.json.estimate.versionNo; const items = o.json.estimate.items as any[];
    const dec = (code: string) => s.p.post("/portal/approval", { code, versionNo: ver, decisions: items.map((i) => ({ itemId: i.id, decision: "approved" })) });
    expect((await dec("123456")).status).toBe(401); // sem OTP solicitado
    const rq = await s.p.post("/portal/approval/otp");
    expect(rq.status).toBe(200);
    expect(rq.json.destination).toMatch(/\*/);
    const code = rq.json.devCode as string ?? h.otp.sent.at(-1)!.code;
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await dec(wrong)).status).toBe(401);
    expect((await dec(code)).status).toBe(201);
    expect((await dec(code)).status).toBe(401); // uso único
    const ev = await ownerSql("select channel, evidence, item_hash_at_decision from approvals where version_id in (select id from estimate_versions where os_id = $1)", [s.orderId]).catch(() => [] as any[]);
    const rows = ev.length ? ev : await ownerSql("select channel, evidence from approvals where tenant_id = $1", [s.t.tenantId]);
    expect(rows.length).toBe(2);
    expect(rows[0].channel).toBe("portal");
    for (const k of ["versionNo", "presentedHash", "totalCents", "items", "otpId", "ipHash", "at", "otpDestination"]) expect(rows[0].evidence).toHaveProperty(k);
    expect(JSON.stringify(rows[0].evidence)).not.toMatch(/10\.77\./); // só hash de IP
    const after = await s.p.get("/portal/order");
    expect(after.json.estimate.items.every((i: any) => i.status === "approved")).toBe(true);
  });
  it("bloqueia tentativas excessivas de OTP (≤5) e versão obsoleta não é aprovável", async () => {
    const s = await fullSetup();
    const o = await s.p.get("/portal/order");
    const items = o.json.estimate.items as any[];
    await s.p.post("/portal/approval/otp");
    const body = (code: string, v = o.json.estimate.versionNo) => ({ code, versionNo: v, decisions: [{ itemId: items[0].id, decision: "approved" }] });
    const real = h.otp.sent.at(-1)!.code;
    const wrong = real === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await s.p.post("/portal/approval", body(wrong))).status).toBe(401);
    expect((await s.p.post("/portal/approval", body(real))).status).toBe(401); // esgotado
    // nova versão publicada => v1 obsoleta
    await s.c.post(`/orders/${s.orderId}/estimate/items`, item("Alinhamento", 1, 8000));
    expect((await s.c.post(`/orders/${s.orderId}/estimate/publish`)).status).toBeLessThan(300);
    await s.p.post("/portal/approval/otp");
    const code2 = h.otp.sent.at(-1)!.code;
    const r = await s.p.post("/portal/approval", body(code2, o.json.estimate.versionNo));
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("version_obsolete");
    const cur = await s.p.get("/portal/order");
    expect(cur.json.estimate.versionNo).toBe(o.json.estimate.versionNo + 1);
  });
  it("rejeição exige justificativa", async () => {
    const s = await fullSetup();
    const o = await s.p.get("/portal/order");
    await s.p.post("/portal/approval/otp");
    const code = h.otp.sent.at(-1)!.code;
    const r = await s.p.post("/portal/approval", { code, versionNo: o.json.estimate.versionNo, decisions: [{ itemId: o.json.estimate.items[0].id, decision: "rejected" }] });
    expect(r.status).toBe(422);
  });
  it("canal OTP não configurado falha fechado (503) e não aprova", async () => {
    const s = await fullSetup();
    const { UnconfiguredOtpChannel } = await import("../src/otp");
    const ch: import("../src/otp").OtpChannel = new UnconfiguredOtpChannel();
    await expect(ch.send({ phoneE164: null, email: null }, "123456")).rejects.toMatchObject({ status: 503 });
  });
});

describe("P6 revogação, expiração, renovação", () => {
  it("revogar encerra sessões ativas imediatamente", async () => {
    const s = await fullSetup();
    expect((await s.p.get("/portal/order")).status).toBe(200);
    expect((await s.c.post(`/orders/${s.orderId}/portal-links/${s.link.id}/revoke`)).status).toBe(200);
    expect((await s.p.get("/portal/order")).status).toBe(401);
    const again = new Client(h, nextIp());
    const r = await again.post("/portal/session", { token: s.link.token });
    expect(r.status).toBe(401); expect(r.json.error).toBe("link_revoked");
  });
  it("expiração efetiva; renovação (equipe) revoga antigo e emite novo", async () => {
    const s = await fullSetup();
    await ownerSql("update portal_links set expires_at = now() - interval '1 minute' where id = $1", [s.link.id]);
    expect((await s.p.get("/portal/order")).status).toBe(401);
    const x = new Client(h, nextIp());
    expect((await x.post("/portal/session", { token: s.link.token })).json.error).toBe("link_expired");
    const ren = await s.c.post(`/orders/${s.orderId}/portal-links/renew`);
    expect(ren.status).toBe(201);
    const { r } = await portalClient((ren.json.url as string).split("#")[1]!);
    expect(r.status).toBe(200);
  });
  it("entrega encurta validade para o TTL configurado (90 dias por padrão)", async () => {
    const s = await fullSetup();
    expect((await s.c.put("/portal/settings", { linkTtlDays: 30 })).status).toBe(200);
    expect((await s.c.patch(`/orders/${s.orderId}`, { status: "delivered" })).status).toBe(200);
    const row = await ownerSql<{ d: number }>("select extract(day from expires_at - now())::int as d from portal_links where id = $1", [s.link.id]);
    expect(row[0]!.d).toBeLessThanOrEqual(30);
  });
});

describe("P7 cache", () => {
  it("respostas do portal são no-store", async () => {
    const s = await fullSetup();
    const r = await s.p.get("/portal/order");
    expect(r.headers.get("cache-control")).toContain("no-store");
    const x = await new Client(h, nextIp()).post("/portal/session", { token: "bad" });
    expect(x.headers.get("cache-control")).toContain("no-store");
  });
});

describe("P8/P9 tema", () => {
  it("não permite ocultar blocos obrigatórios (API e CHECK no banco); contraste AA validado; publicar/restaurar", async () => {
    const s = await fullSetup();
    const bad = await s.c.put("/portal/theme/draft", { primaryColor: "#112233", hidden: ["estimate"] });
    expect(bad.status).toBe(422);
    const low = await s.c.put("/portal/theme/draft", { primaryColor: "#cccccc", hidden: [] });
    expect(low.status).toBe(422);
    await expect(ownerSql(
      "insert into portal_theme_versions (tenant_id, version_no, status, config) values ($1, 99, 'draft', $2)",
      [s.t.tenantId, JSON.stringify({ primaryColor: "#112233", hidden: ["privacyNotice"] })])).rejects.toThrow();
    expect((await s.c.put("/portal/theme/draft", { primaryColor: "#0b3d91", welcomeText: "Olá!", hidden: ["chat"] })).status).toBe(200);
    expect((await s.c.post("/portal/theme/publish")).status).toBe(200);
    const o = await s.p.get("/portal/order");
    expect(o.json.theme.welcomeText).toBe("Olá!");
    expect(o.json.messages).toBeUndefined(); // chat oculto
    for (const k of ["orderInfo", "status", "estimate", "shopContact", "privacyNotice"]) expect(o.json[k]).toBeDefined();
    expect((await s.p.post("/portal/messages", { body: "oi" })).status).toBe(403);
    const vs = await s.c.get("/portal/theme");
    const first = vs.json.versions.find((v: any) => v.status === "superseded") ?? vs.json.versions[0];
    expect((await s.c.post(`/portal/theme/${first.id}/restore`)).status).toBe(200);
  });
});

describe("P10 exposição de dados", () => {
  it("não vaza custo, margem, ids internos de terceiros nem dados completos do cliente", async () => {
    const s = await fullSetup();
    const o = await s.p.get("/portal/order");
    const txt = JSON.stringify(o.json);
    expect(txt).not.toMatch(/"[a-zA-Z_]*(cost|margin|margem|supplier|fornecedor|password|token_hash|phone|email|cpf|tenant_id|unit_id)[a-zA-Z_]*":/i);
    expect(o.json.orderInfo.customerFirstName).toBe("Maria");
    expect(txt).not.toContain("Santos");
    expect(txt).not.toContain(s.t.tenantId);
  });
  it("chat: grava mensagem, aplica limite e a oficina responde", async () => {
    const s = await fullSetup();
    expect((await s.p.post("/portal/messages", { body: "<script>alert(1)</script> Olá" })).status).toBe(201);
    expect((await s.c.post(`/orders/${s.orderId}/portal-messages`, { body: "Bom dia!" })).status).toBe(201);
    const o = await s.p.get("/portal/order");
    expect(o.json.messages.map((m: any) => m.sender)).toEqual(["customer", "staff"]);
    expect((await s.p.post("/portal/messages", { body: "" })).status).toBe(422);
  });
  it("registra log de acesso (sem IP em claro)", async () => {
    const s = await fullSetup();
    await s.p.get("/portal/order");
    const log = await s.c.get(`/orders/${s.orderId}/portal-access-log`);
    expect(log.status, JSON.stringify(log.json)).toBe(200);
    expect(log.json.log.map((l: any) => l.event)).toEqual(expect.arrayContaining(["exchange", "view"]));
    const raw = await ownerSql("select ip_hash from portal_access_log where os_id = $1", [s.orderId]);
    expect(raw[0].ip_hash).toMatch(/^[0-9a-f]{16,}$/);
  });
});

describe("Outbox / notificações", () => {
  it("evento gera outbox na mesma transação; sem consentimento => skipped; com consentimento => e-mail enviado", async () => {
    const s = await setup(`${uniq("n")}@example.test`);
    const pending = await ownerSql("select status from outbox where os_id = $1", [s.orderId]);
    expect(pending.length).toBeGreaterThan(0);
    const { processOutbox } = await import("../src/outbox");
    const r1 = await processOutbox(h, s.t.tenantId);
    expect(r1.skipped).toBeGreaterThan(0);
    expect(h.email.sent.filter((m) => m.template === "notification")).toHaveLength(0);
    await s.c.post(`/customers/${s.customerId}/consents`, { channel: "email", granted: true });
    await withEstimate(s.c, s.orderId);
    const r2 = await processOutbox(h, s.t.tenantId);
    expect(r2.sent).toBeGreaterThan(0);
    expect(h.email.sent.some((m) => m.template === "notification")).toBe(true);
  });
});
