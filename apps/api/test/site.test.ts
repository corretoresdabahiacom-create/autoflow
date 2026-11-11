import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/password";
import { processOutbox } from "../src/outbox";
import { Client, type Harness, type SeededTenant, PW, loginOwner, makeHarness, ownerSql, seedTenant, uniq } from "./harness";

let h: Harness;
beforeAll(() => { h = makeHarness(); });
afterAll(async () => h.db.close());

let ipn = 1;
const nextIp = () => `10.55.${Math.floor(ipn / 250)}.${(ipn++ % 250) + 1}`;
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ORIGIN = "http://localhost:8787";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

const get = (path: string, headers: Record<string, string> = {}) => Promise.resolve(h.app.request(path, { headers: { "user-agent": BROWSER, "x-real-ip": nextIp(), ...headers } }));
const text = async (path: string, headers: Record<string, string> = {}) => { const r = await get(path, headers); return { status: r.status, headers: r.headers, body: await r.text() }; };
const lead = async (slug: string, fields: Record<string, string>, opts: { files?: Uint8Array[]; json?: boolean; origin?: string; ip?: string } = {}) => {
  const hd: Record<string, string> = { origin: opts.origin ?? ORIGIN, "x-real-ip": opts.ip ?? nextIp(), "user-agent": BROWSER };
  let body: BodyInit;
  if (opts.json) { hd["content-type"] = "application/json"; hd.accept = "application/json"; body = JSON.stringify(fields); }
  else { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); for (const f of opts.files ?? []) fd.append("photos", new File([f as BlobPart], "p.png", { type: "image/png" })); body = fd; }
  return Promise.resolve(h.app.request(`/o/${slug}/lead`, { method: "POST", headers: hd, body }));
};
const GOOD = { name: "João Pereira", phone: "(71) 98888-7777", vehicle: "Gol 2015", service: "Freios", description: "Barulho ao frear", "cf-turnstile-response": "ok-token" };

async function addMember(t: SeededTenant, role: string) {
  const email = `${uniq("m")}@example.test`;
  const u = await ownerSql<{ id: string }>("insert into users (email, password_hash) values ($1,$2) returning id", [email, await hashPassword(PW, 10)]);
  const r = await ownerSql<{ id: string }>("select id from roles where tenant_id is null and key = $1", [role]);
  await ownerSql("insert into memberships (tenant_id, user_id, role_id, status, all_units) values ($1,$2,$3,'active',true)", [t.tenantId, u[0]!.id, r[0]!.id]);
  const cl = new Client(h, nextIp());
  expect((await cl.post("/auth/login", { email, password: PW, tenantSlug: t.slug })).status).toBe(200);
  return cl;
}
const upload = (c: Client, bytes: Uint8Array, path = "/site/media", type = "image/png") => {
  const fd = new FormData(); fd.set("file", new File([bytes as BlobPart], "x.png", { type }));
  return Promise.resolve(h.app.request(path, { method: "POST", headers: { origin: "http://localhost:5173", "x-real-ip": nextIp(), cookie: [...c.cookies].map(([a, b]) => `${a}=${b}`).join("; ") }, body: fd }))
    .then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
};
const baseCfg = (name = "Auto Center Teste", extra: Record<string, unknown> = {}) => ({
  business: { name, tagline: "Revisão completa", about: "Somos especialistas.", phone: "(71) 3333-4444", whatsapp: "(71) 99999-1234", email: "contato@oficina.test",
    address: { street: "Rua das Flores, 100", city: "Salvador", state: "BA", zip: "40000-000" }, hours: [{ days: "Seg a Sex", open: "8h às 18h" }] },
  services: [{ title: "Freios", description: "Pastilhas e discos", priceFrom: "R$ 150" }, { title: "Suspensão" }], gallery: [], testimonials: [],
  sections: { services: true, about: true, gallery: true, hours: true, testimonials: false }, theme: { primaryColor: "#0b3d91" }, seo: {}, cta: { text: "Peça seu orçamento" }, ...extra,
});
async function setup(config: unknown = baseCfg(), template = "moderno") {
  const t = await seedTenant(h); const c = await loginOwner(h, t, nextIp());
  const d = await c.put("/site/draft", { template, config }); expect(d.status, JSON.stringify(d.json)).toBe(200);
  const p = await c.post("/site/publish"); expect(p.status, JSON.stringify(p.json)).toBe(200);
  return { t, c, slug: t.slug, etag: p.json.etag as string };
}

describe("S1 SSR sem JS, SEO e cache", () => {
  it("HTML completo, canonical/OG/JSON-LD, nenhum script executável, CSP, ETag/304, sitemap e robots", async () => {
    const s = await setup();
    const r = await text(`/o/${s.slug}`);
    expect(r.status).toBe(200); expect(r.headers.get("content-type")).toContain("text/html");
    for (const frag of ["Auto Center Teste", "Freios", "Pastilhas e discos", "<form", `rel="canonical" href="http://localhost:8787/o/${s.slug}"`, 'property="og:title"', '"@type":"AutoRepair"', "Seg a Sex", "Salvador", "https://wa.me/5571999991234", "lang=\"pt-BR\"", "name=\"viewport\""]) expect(r.body).toContain(frag);
    expect(r.body).not.toMatch(/<script(?![^>]*application\/ld\+json)/i); expect(r.body).not.toMatch(/\son[a-z]+=/i);
    expect(r.headers.get("content-security-policy")).toMatch(/default-src 'none'/); expect(r.headers.get("content-security-policy")).not.toMatch(/script-src/);
    expect(r.headers.get("cache-control")).toMatch(/public.*s-maxage/); expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const etag = r.headers.get("etag")!; expect(etag).toContain(s.etag);
    expect((await get(`/o/${s.slug}`, { "if-none-match": etag })).status).toBe(304);
    const card = await text(`/c/${s.slug}`); expect(card.status).toBe(200); expect(card.body).toContain("vcard.vcf"); expect(card.body).toContain("qr.svg"); expect(card.body).toContain("tel:+5571");
    const sm = await text("/sitemap.xml"); expect(sm.body).toContain(`/o/${s.slug}<`); expect(sm.body).toContain(`/c/${s.slug}<`);
    expect((await text("/robots.txt")).body).toMatch(/Sitemap: .*sitemap\.xml/);
  });
  it("vCard (escapes), QR SVG/PNG", async () => {
    const s = await setup(baseCfg("Oficina; Silva, Filhos"));
    const v = await get(`/c/${s.slug}/vcard.vcf`); const body = await v.text();
    expect(v.headers.get("content-type")).toContain("text/vcard"); expect(body).toContain("BEGIN:VCARD"); expect(body).toContain("FN:Oficina\; Silva\\, Filhos"); expect(body).toContain("\r\n");
    expect(await (await get(`/c/${s.slug}/qr.svg`)).text()).toContain("<svg");
    const png = new Uint8Array(await (await get(`/c/${s.slug}/qr.png`)).arrayBuffer()); expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("S2 slug, suspensão e não publicado", () => {
  it("slug inexistente/não publicado = 404; tenant suspenso = 404 e fora do sitemap; slug reservado já bloqueado no banco", async () => {
    expect((await text("/o/nao-existe-xyz")).status).toBe(404);
    expect((await text("/o/AB")).status).toBe(404);
    const t = await seedTenant(h); expect((await text(`/o/${t.slug}`)).status).toBe(404); // sem publicação
    const s = await setup();
    expect((await text(`/o/${s.slug}`)).status).toBe(200);
    await ownerSql("update tenants set status = 'suspended', suspended_reason = 'teste' where id = $1", [s.t.tenantId]);
    expect((await text(`/o/${s.slug}`)).status).toBe(404); expect((await text(`/c/${s.slug}`)).status).toBe(404); expect((await text(`/c/${s.slug}/vcard.vcf`)).status).toBe(404);
    expect((await text("/sitemap.xml")).body).not.toContain(`/o/${s.slug}<`);
    await expect(ownerSql("insert into tenants (name, slug) values ('x', 'admin')")).rejects.toThrow();
  });
});

describe("S3 XSS e URLs perigosas", () => {
  it("script/atributos injetados em qualquer campo são escapados; javascript:/http:/data: rejeitados no editor", async () => {
    const X = `<script>alert(1)</script>"'`; const Y = `"><img src=x onerror=alert(2)>`;
    const cfg = baseCfg(X, { services: [{ title: X, description: X, priceFrom: X }], testimonials: [{ author: X, text: X }], sections: { services: true, about: true, gallery: true, hours: true, testimonials: true }, seo: { title: X, description: X }, cta: { text: X } });
    (cfg.business as any).about = X + Y; (cfg.business as any).tagline = Y; (cfg.business as any).hours = [{ days: X, open: X }]; (cfg.business as any).address = { street: X, city: X, state: "BA" };
    const s = await setup(cfg);
    const r = await text(`/o/${s.slug}`); const card = await text(`/c/${s.slug}`); const vc = await (await get(`/c/${s.slug}/vcard.vcf`)).text();
    for (const body of [r.body, card.body]) {
      expect(body).not.toContain("<script>alert"); expect(body).not.toContain("<img src=x"); expect(body).not.toContain('"><img'); expect(body).not.toContain("<img src=x");
      expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;"); expect(body).not.toMatch(/<script(?![^>]*application\/ld\+json)/i);
    }
    const ld = r.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!; expect(ld).not.toContain("<"); expect(JSON.parse(ld).name).toBe(X); // JSON-LD sem "<" (escapado)
    expect(vc.split("\r\n").every((l) => !l.includes("\n"))).toBe(true);
    for (const bad of ["javascript:alert(1)", "http://insegura.test", "data:text/html,<script>alert(1)</script>", "JaVaScRiPt:alert(1)", "//evil.test"]) {
      const c2 = baseCfg(); (c2.business as any).instagram = bad; (c2.business as any).mapUrl = bad;
      const d = await s.c.put("/site/draft", { template: "moderno", config: c2 }); expect(d.status).toBe(422);
    }
    expect((await s.c.put("/site/draft", { template: "<script>", config: baseCfg() })).status).toBe(422);
    expect((await s.c.put("/site/draft", { template: "moderno", config: baseCfg("X", { gallery: [{ mediaId: "javascript:alert(1)", alt: "a" }] }) })).status).toBe(422);
  });
});

describe("S4 isolamento", () => {
  it("mídia, rascunho, versões e leads de A inacessíveis a B", async () => {
    const A = await setup(); const B = await setup();
    const m = await upload(A.c, PNG); expect(m.status, JSON.stringify(m.json)).toBe(201);
    const cfg = baseCfg("A", { gallery: [{ mediaId: m.json.id, alt: "foto" }] });
    expect((await A.c.put("/site/draft", { template: "moderno", config: cfg })).status).toBe(200); expect((await A.c.post("/site/publish")).status).toBe(200);
    expect((await get(`/m/${A.slug}/${m.json.id}`)).status).toBe(200);
    expect((await get(`/m/${B.slug}/${m.json.id}`)).status).toBe(404);
    expect((await B.c.get("/site/media")).json.media).toHaveLength(0);
    const vs = (await A.c.get("/site/versions")).json.versions;
    expect((await B.c.post(`/site/versions/${vs[0].id}/restore`)).status).toBe(404);
    await lead(A.slug, GOOD); const la = (await A.c.get("/leads")).json.leads;
    expect(la).toHaveLength(1); expect((await B.c.get("/leads")).json.leads).toHaveLength(0); expect((await B.c.get(`/leads/${la[0].id}`)).status).toBe(404);
    expect((await B.c.patch(`/leads/${la[0].id}/status`, { status: "contacted" })).status).toBe(404);
  });
  it("mídia: SVG/PDF/HTML rejeitados; servida com nosniff e CSP restritiva", async () => {
    const s = await setup();
    expect((await upload(s.c, new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"), "/site/media", "image/svg+xml")).status).toBe(422);
    expect((await upload(s.c, new TextEncoder().encode("%PDF-1.4 x"), "/site/media", "application/pdf")).status).toBe(422);
    expect((await upload(s.c, PNG, "/site/media", "text/html")).status).toBe(422);
    const m = await upload(s.c, PNG); const r = await get(`/m/${s.slug}/${m.json.id}`);
    expect(r.headers.get("content-type")).toBe("image/png"); expect(r.headers.get("x-content-type-options")).toBe("nosniff"); expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});

describe("S5 formulário de orçamento → lead", () => {
  it("cria lead na unidade/tenant corretos com origem/campanha; fotos validadas; notifica a equipe", async () => {
    const s = await setup();
    const r = await lead(s.slug, { ...GOOD, plate: "abc1d23", campaign: "instagram_nov", email: "joao@example.test" }, { files: [PNG] });
    expect(r.status).toBe(303); expect(r.headers.get("location")).toContain("sent=1");
    const rows = await ownerSql<any>("select * from leads where tenant_id = $1", [s.t.tenantId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "site", campaign: "instagram_nov", phone_e164: "+5571988887777", plate: "ABC1D23", status: "new" });
    const def = await ownerSql<{ id: string }>("select id from units where tenant_id = $1 and is_default", [s.t.tenantId]); expect(rows[0].unit_id).toBe(def[0]!.id);
    expect(await ownerSql("select 1 from lead_media where lead_id = $1", [rows[0].id])).toHaveLength(1);
    expect(await ownerSql("select 1 from lead_events where lead_id = $1 and kind = 'created'", [rows[0].id])).toHaveLength(1);
    expect(await ownerSql("select 1 from outbox where tenant_id = $1 and kind = 'lead.new'", [s.t.tenantId])).toHaveLength(1);
    const before = h.email.sent.length; expect((await processOutbox(h, s.t.tenantId)).sent).toBeGreaterThan(0); expect(h.email.sent.length).toBeGreaterThan(before);
    const media = (await s.c.get(`/leads/${rows[0].id}`)).json.media[0]; expect((await s.c.get(`/leads/${rows[0].id}/media/${media.id}`)).status).toBe(200);
    expect((await new Client(h, nextIp()).get(`/leads/${rows[0].id}/media/${media.id}`)).status).toBe(401);
  });
  it("JSON, captcha obrigatório, honeypot, origem, telefone, fotos e rate limit", async () => {
    const s = await setup();
    expect((await lead(s.slug, GOOD, { json: true })).status).toBe(201);
    const noCap = await lead(s.slug, { ...GOOD, "cf-turnstile-response": "" }, { json: true }); expect(noCap.status).toBe(403); expect((await noCap.json()).error).toBe("captcha_failed");
    expect((await lead(s.slug, { ...GOOD, "cf-turnstile-response": "wrong" }, { json: true })).status).toBe(403);
    const hp = await lead(s.slug, { ...GOOD, website: "http://spam.test" }, { json: true }); expect(hp.status).toBe(201); // finge sucesso
    expect((await lead(s.slug, GOOD, { json: true, origin: "https://evil.test" })).status).toBe(403);
    expect((await lead(s.slug, { ...GOOD, phone: "123" }, { json: true })).status).toBe(422);
    expect((await lead(s.slug, { ...GOOD, plate: "ZZ" }, { json: true })).status).toBe(422);
    expect((await lead(s.slug, { ...GOOD, name: "" }, { json: true })).status).toBe(422);
    const bad = await lead(s.slug, GOOD, { files: [new TextEncoder().encode("<html><script>alert(1)</script></html>")] }); expect(bad.headers.get("location")).toContain("err=");
    expect((await lead(s.slug, GOOD, { files: [PNG, PNG, PNG, PNG] })).headers.get("location")).toContain("err=too_many_photos");
    expect(await ownerSql("select 1 from leads where tenant_id = $1", [s.t.tenantId])).toHaveLength(1); // só o primeiro JSON válido
    const ip = nextIp(); const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await lead(s.slug, GOOD, { json: true, ip })).status);
    expect(codes.slice(0, 4)).toEqual([201, 201, 201, 201]); expect(codes).toContain(429);
    expect((await lead("nao-existe-xyz", GOOD, { json: true })).status).toBe(404);
  });
  it("captcha de produção não configurado falha fechado (503)", async () => {
    const { UnconfiguredCaptcha } = await import("../src/captcha");
    await expect(new UnconfiguredCaptcha().verify()).rejects.toMatchObject({ status: 503 });
  });
});

describe("S6 estatísticas sem PII", () => {
  it("conta visita humana; ignora bots, DNT e GPC; classifica origem; tabela não guarda IP/UA", async () => {
    const s = await setup();
    await get(`/o/${s.slug}`); await get(`/o/${s.slug}`, { referer: "https://www.google.com/search?q=oficina" }); await get(`/c/${s.slug}`, { referer: "https://l.instagram.com/" });
    await get(`/o/${s.slug}`, { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" }); await get(`/o/${s.slug}`, { "user-agent": "curl/8.0" });
    await get(`/o/${s.slug}`, { dnt: "1" }); await get(`/o/${s.slug}`, { "sec-gpc": "1" });
    const day = new Date().toISOString().slice(0, 10); const prev = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    const st = await s.c.get(`/site/stats?from=${prev}&to=${day}`); expect(st.status).toBe(200);
    expect(st.json.totals.site).toBe(2); expect(st.json.totals.card).toBe(1);
    expect(st.json.rows.map((r: any) => `${r.page}:${r.source}`).sort()).toEqual(["card:social", "site:direct", "site:search"]);
    const cols = await ownerSql<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'site_stats_daily' order by 1");
    expect(cols.map((c) => c.column_name)).toEqual(["day", "page", "source", "tenant_id", "visits"]);
  });
});

describe("S7 mapa opcional", () => {
  it("sem provedor de mapa: sem iframe/script externo; link de mapa é fallback https", async () => {
    const cfg = baseCfg(); delete (cfg.business as any).address;
    const s = await setup(cfg); const r = await text(`/o/${s.slug}`);
    expect(r.status).toBe(200); expect(r.body).not.toMatch(/iframe|maps\.googleapis|google\.com\/maps/); expect(r.body).not.toContain("Abrir no mapa");
    const s2 = await setup(); const r2 = await text(`/o/${s2.slug}`);
    expect(r2.body).toContain("openstreetmap.org/search?query="); expect(r2.body).not.toContain("<iframe"); expect(r2.body).toContain("Rua das Flores, 100");
  });
});

describe("S8 publicar/restaurar, cache, contraste", () => {
  it("nova publicação troca conteúdo e ETag; restaurar volta o conteúdo; ETag antigo não valida mais; revalidação pelas regras atuais", async () => {
    const s = await setup(baseCfg("Versão Um")); const r1 = await get(`/o/${s.slug}`); const e1 = r1.headers.get("etag")!; expect(await r1.text()).toContain("Versão Um");
    expect((await s.c.put("/site/draft", { template: "premium", config: baseCfg("Versão Dois") })).status).toBe(200);
    expect((await get(`/o/${s.slug}`)).headers.get("etag")).toBe(e1); // rascunho não vaza
    expect((await s.c.post("/site/publish")).status).toBe(200);
    const r2 = await get(`/o/${s.slug}`); const e2 = r2.headers.get("etag")!; expect(e2).not.toBe(e1); expect(await r2.text()).toContain("Versão Dois");
    expect((await get(`/o/${s.slug}`, { "if-none-match": e1 })).status).toBe(200); expect((await get(`/o/${s.slug}`, { "if-none-match": e2 })).status).toBe(304);
    const vs = (await s.c.get("/site/versions")).json.versions; const v1 = vs.find((v: any) => v.version_no === 1);
    expect((await s.c.post(`/site/versions/${v1.id}/restore`)).status).toBe(200);
    const r3 = await get(`/o/${s.slug}`); expect(await r3.text()).toContain("Versão Um"); expect(r3.headers.get("etag")).not.toBe(e1); expect(r3.headers.get("etag")).not.toBe(e2);
    expect((await s.c.get("/site/versions")).json.versions.filter((v: any) => v.status === "published")).toHaveLength(1);
    await ownerSql("insert into site_versions (tenant_id, version_no, status, template, config) values ($1, 99, 'superseded', 'moderno', $2)", [s.t.tenantId, JSON.stringify(baseCfg("Ruim", { theme: { primaryColor: "#ffff00" } }))]);
    const bad = (await s.c.get("/site/versions")).json.versions.find((v: any) => v.version_no === 99);
    expect((await s.c.post(`/site/versions/${bad.id}/restore`)).status).toBe(422);
    expect((await s.c.post("/site/publish")).status).toBe(409); // sem rascunho
  });
  it("tema sem contraste AA é barrado antes de publicar", async () => {
    const t = await seedTenant(h); const c = await loginOwner(h, t, nextIp());
    const d = await c.put("/site/draft", { template: "moderno", config: baseCfg("X", { theme: { primaryColor: "#ffff00" } }) });
    expect(d.status).toBe(422); expect(JSON.stringify(d.json)).toMatch(/contraste/);
    expect((await c.put("/site/draft", { template: "moderno", config: baseCfg("X", { theme: { primaryColor: "#0b3d91", accentColor: "#ffeb3b" } }) })).status).toBe(422);
  });
});

describe("CRM básico e permissões", () => {
  it("funil: mover, perdido exige motivo, histórico; atendente gerencia leads mas não edita site; mecânico sem acesso", async () => {
    const s = await setup(); await lead(s.slug, GOOD, { json: true });
    const att = await addMember(s.t, "attendant"); const mec = await addMember(s.t, "mechanic");
    const l = (await att.get("/leads")).json; expect(l.counts.new).toBe(1); const id = l.leads[0].id;
    expect((await att.patch(`/leads/${id}/status`, { status: "contacted", note: "liguei" })).status).toBe(200);
    expect((await att.patch(`/leads/${id}/status`, { status: "lost" })).status).toBe(422);
    expect((await att.patch(`/leads/${id}/status`, { status: "lost", lostReason: "preço" })).status).toBe(200);
    expect((await att.post(`/leads/${id}/notes`, { note: "cliente retornou" })).status).toBe(201);
    const d = (await att.get(`/leads/${id}`)).json; expect(d.status).toBe("lost"); expect(d.events.map((e: any) => e.kind)).toEqual(["created", "status", "status", "note"]);
    expect((await att.get("/leads?status=lost")).json.leads).toHaveLength(1);
    expect((await att.put("/site/draft", { template: "moderno", config: baseCfg() })).status).toBe(403);
    expect((await att.post("/site/publish")).status).toBe(403);
    expect((await mec.get("/leads")).status).toBe(403); expect((await mec.get("/site")).status).toBe(403);
    await expect(h.db.tx({ actor: "tenant", tenantId: s.t.tenantId, unitScope: "all" }, (q) => q.query("delete from lead_events"))).rejects.toThrow();
  });
});
