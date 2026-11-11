import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, type SeededTenant, loginOwner, makeHarness, ownerSql, seedTenant, uniq } from "./harness";

let h: Harness;
beforeAll(() => { h = makeHarness(); });
afterAll(async () => h.db.close());

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function setup(opts: { plan?: string; units?: number } = {}) {
  const t = await seedTenant(h, opts);
  const c = await loginOwner(h, t, `10.20.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`);
  return { t, c };
}
async function mkOrder(c: Client, plate = `ABC${Math.floor(Math.random() * 9)}D${Math.floor(Math.random() * 90 + 10)}`, unitId?: string) {
  const cu = await c.post("/customers", { name: `Cliente ${uniq("c")}`, phone: "(71) 99999-1234" });
  expect(cu.status).toBe(201);
  const ve = await c.post(`/customers/${cu.json.id}/vehicles`, { plate, make: "VW", model: "Gol", km: 1000 });
  expect(ve.status, JSON.stringify(ve.json)).toBe(201);
  const o = await c.post("/orders", { customerId: cu.json.id, vehicleId: ve.json.id, unitId });
  expect(o.status, JSON.stringify(o.json)).toBe(201);
  return { customerId: cu.json.id as string, vehicleId: ve.json.id as string, orderId: o.json.id as string, number: o.json.number as number };
}
const item = (d = "Troca de óleo", qty = 1, price = 15000) => ({ description: d, category: "service", qty, unitPriceCents: price });
async function upload(c: Client, orderId: string, bytes: Uint8Array, type = "image/png", kind = "photo") {
  const fd = new FormData();
  fd.set("file", new File([bytes as BlobPart], "x.bin", { type }));
  fd.set("kind", kind);
  const res = await h.app.request(`/orders/${orderId}/attachments`, {
    method: "POST",
    headers: { origin: "http://localhost:5173", cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join("; "), "x-real-ip": "10.99.0.1" },
    body: fd,
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe("C1 placa única por tenant", () => {
  it("mesma placa em tenants diferentes é permitida e isolada; duplicada no mesmo tenant é 409", async () => {
    const A = await setup(); const B = await setup();
    const a = await mkOrder(A.c, "XYZ1A23");
    const b = await mkOrder(B.c, "XYZ1A23");
    expect(a.vehicleId).not.toBe(b.vehicleId);
    const dup = await A.c.post(`/customers/${a.customerId}/vehicles`, { plate: "xyz-1a23" });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe("plate_exists");
    const sA = await A.c.get("/search?q=XYZ1A23");
    expect(sA.json.vehicles).toHaveLength(1);
    expect(sA.json.vehicles[0].id).toBe(a.vehicleId);
  });
  it("OS de um tenant não aparece nem é acessível por outro", async () => {
    const A = await setup(); const B = await setup();
    const a = await mkOrder(A.c);
    expect((await B.c.get(`/orders/${a.orderId}`)).status).toBe(404);
    expect((await B.c.post(`/orders/${a.orderId}/estimate/items`, item())).status).toBe(404);
  });
});

describe("C2 numeração concorrente", () => {
  it("50 criações simultâneas geram números 1..50 sem duplicidade", async () => {
    const { t, c } = await setup({ units: 1 });
    const cu = await c.post("/customers", { name: "Cliente Concorrente" });
    const ve = await c.post(`/customers/${cu.json.id}/vehicles`, { plate: "CON1C23" });
    const res = await Promise.all(Array.from({ length: 50 }, () => c.post("/orders", { customerId: cu.json.id, vehicleId: ve.json.id })));
    expect(res.every((r) => r.status === 201)).toBe(true);
    const nums = res.map((r) => r.json.number as number).sort((x, y) => x - y);
    expect(nums).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const dups = await ownerSql("select number from service_orders where tenant_id = $1 group by number having count(*) > 1", [t.tenantId]);
    expect(dups).toHaveLength(0);
  });
  it("numeração é independente por unidade", async () => {
    const { t, c } = await setup({ units: 2 });
    const a = await mkOrder(c, "UNA1A11", t.unitIds[0]);
    const b = await mkOrder(c, "UNB1B22", t.unitIds[1]);
    expect([a.number, b.number]).toEqual([1, 1]);
  });
});

describe("C3 versões imutáveis e diff", () => {
  it("publicada não pode ser editada nem apagada (banco); editar via API cria v2 e mostra diff", async () => {
    const { t, c } = await setup();
    const o = await mkOrder(c);
    const i1 = await c.post(`/orders/${o.orderId}/estimate/items`, item("Troca de óleo", 1, 15000));
    await c.post(`/orders/${o.orderId}/estimate/items`, item("Filtro", 1, 5000));
    expect((await c.post(`/orders/${o.orderId}/estimate/publish`)).status).toBe(201);

    // proteção no banco (mesmo com superusuário): triggers
    await expect(ownerSql("update estimate_items set qty = 9 where tenant_id = $1", [t.tenantId])).rejects.toThrow(/imutáveis/);
    await expect(ownerSql("delete from estimate_items where tenant_id = $1", [t.tenantId])).rejects.toThrow(/imutáveis/);
    await expect(ownerSql("update estimate_versions set total_cents = 1 where tenant_id = $1", [t.tenantId])).rejects.toThrow(/imutável/);
    await expect(ownerSql("delete from estimate_versions where tenant_id = $1", [t.tenantId])).rejects.toThrow(/apagada/);

    // sem mudanças não publica
    expect((await c.post(`/orders/${o.orderId}/estimate/publish`)).status).toBe(409);

    // alteração via API → v2
    expect((await c.patch(`/orders/${o.orderId}/estimate/items/${i1.json.lineKey}`, { qty: 2 })).status).toBe(200);
    await c.post(`/orders/${o.orderId}/estimate/items`, item("Alinhamento", 1, 8000));
    const pub2 = await c.post(`/orders/${o.orderId}/estimate/publish`);
    expect(pub2.json.versionNo).toBe(2);
    const est = await c.get(`/orders/${o.orderId}/estimate`);
    expect(est.json.versions.map((v: any) => [v.versionNo, v.status])).toEqual([[1, "superseded"], [2, "published"]]);
    // v1 intacta
    expect(est.json.versions[0].items.find((x: any) => x.description === "Troca de óleo").qty).toBe(1);
    const diff = (await c.get(`/orders/${o.orderId}/estimate/diff?from=1&to=2`)).json;
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes[0]).toMatchObject({ field: "qty", from: 1, to: 2 });
    expect(diff.added).toHaveLength(1);
    expect(diff.unchanged).toHaveLength(1);
  });
});

describe("C4 aprovações e herança", () => {
  it("item alterado na v2 NÃO herda aprovação; item idêntico herda (regra explícita); recusa não herda", async () => {
    const { c } = await setup();
    const o = await mkOrder(c);
    const a = await c.post(`/orders/${o.orderId}/estimate/items`, item("Serviço A", 1, 10000));
    await c.post(`/orders/${o.orderId}/estimate/items`, item("Serviço B", 1, 20000));
    await c.post(`/orders/${o.orderId}/estimate/items`, item("Serviço C", 1, 30000));
    await c.post(`/orders/${o.orderId}/estimate/publish`);
    const v1 = (await c.get(`/orders/${o.orderId}/estimate`)).json.versions[0].items as any[];
    const id = (d: string) => v1.find((x) => x.description === d).id;
    const dec = await c.post(`/orders/${o.orderId}/estimate/decisions`, {
      customerName: "Maria Cliente",
      decisions: [{ itemId: id("Serviço A"), decision: "approved" }, { itemId: id("Serviço B"), decision: "approved" }, { itemId: id("Serviço C"), decision: "rejected", justification: "muito caro" }],
    });
    expect(dec.status, JSON.stringify(dec.json)).toBe(201);
    // v2: altera B (preço), mantém A e C, adiciona D
    const bKey = v1.find((x) => x.description === "Serviço B").lineKey;
    await c.patch(`/orders/${o.orderId}/estimate/items/${bKey}`, { unitPriceCents: 25000 });
    await c.post(`/orders/${o.orderId}/estimate/items`, item("Serviço D", 1, 1000));
    await c.post(`/orders/${o.orderId}/estimate/publish`);
    const v2 = (await c.get(`/orders/${o.orderId}/estimate`)).json.versions[1].items as any[];
    const st = (d: string) => v2.find((x) => x.description === d).status;
    expect(st("Serviço A")).toBe("approved_inherited");
    expect(st("Serviço B")).toBe("pending");
    expect(st("Serviço C")).toBe("pending");
    expect(st("Serviço D")).toBe("pending");
    void a;
  });

  it("decisão exige justificativa na recusa, é única por item e registra evidência com hash", async () => {
    const { t, c } = await setup();
    const o = await mkOrder(c);
    await c.post(`/orders/${o.orderId}/estimate/items`, item());
    await c.post(`/orders/${o.orderId}/estimate/publish`);
    const it = (await c.get(`/orders/${o.orderId}/estimate`)).json.versions[0].items[0];
    const bad = await c.post(`/orders/${o.orderId}/estimate/decisions`, { customerName: "Maria", decisions: [{ itemId: it.id, decision: "rejected" }] });
    expect(bad.status).toBe(422);
    expect((await c.post(`/orders/${o.orderId}/estimate/decisions`, { customerName: "Maria", decisions: [{ itemId: it.id, decision: "approved" }] })).status).toBe(201);
    expect((await c.post(`/orders/${o.orderId}/estimate/decisions`, { customerName: "Maria", decisions: [{ itemId: it.id, decision: "rejected", justification: "mudei de ideia" }] })).status).toBe(409);
    const rows = await ownerSql("select item_hash_at_decision, evidence, channel from approvals where tenant_id = $1", [t.tenantId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].evidence.declaredCustomerName).toBe("Maria");
    expect(rows[0].evidence.presentedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].channel).toBe("assisted");
    await expect(ownerSql("update approvals set decision = 'rejected' where tenant_id = $1", [t.tenantId])).rejects.toThrow(/append-only/);
    await expect(ownerSql("delete from approvals where tenant_id = $1", [t.tenantId])).rejects.toThrow(/append-only/);
  });

  it("C5: aprovar não cria nenhum registro financeiro (só approvals e auditoria mudam)", async () => {
    const { t, c } = await setup();
    const o = await mkOrder(c);
    await c.post(`/orders/${o.orderId}/estimate/items`, item());
    await c.post(`/orders/${o.orderId}/estimate/publish`);
    const it = (await c.get(`/orders/${o.orderId}/estimate`)).json.versions[0].items[0];
    const snapshot = async () => {
      const tables = await ownerSql<{ t: string }>("select table_name as t from information_schema.columns where table_schema='public' and column_name='tenant_id' and table_name not in ('sessions','auth_tokens')");
      const out: Record<string, number> = {};
      for (const { t: name } of tables) out[name] = Number((await ownerSql(`select count(*)::int as n from ${name} where tenant_id = $1`, [t.tenantId]))[0]!.n);
      return out;
    };
    const before = await snapshot();
    await c.post(`/orders/${o.orderId}/estimate/decisions`, { customerName: "Maria", decisions: [{ itemId: it.id, decision: "approved" }] });
    const after = await snapshot();
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]).sort();
    expect(changed).toEqual(["approvals", "audit_log", "outbox", "os_timeline"].sort()); // Fase 3: timeline + outbox transacionais; nada financeiro
    expect(await ownerSql("select 1 from ledger_txns where tenant_id = $1", [t.tenantId])).toHaveLength(0); // aprovação não gera lançamento financeiro (Fase 5, critério 3)
  });
});

describe("C6 bloqueio de execução", () => {
  it("item não aprovado/pendente/recusado é bloqueado; aprovado (ou herdado) executa; uma vez só", async () => {
    const { c } = await setup();
    const o = await mkOrder(c);
    await c.post(`/orders/${o.orderId}/estimate/items`, item("Serviço A"));
    await c.post(`/orders/${o.orderId}/estimate/items`, item("Serviço B"));
    await c.post(`/orders/${o.orderId}/estimate/publish`);
    const its = (await c.get(`/orders/${o.orderId}/estimate`)).json.versions[0].items as any[];
    const A = its.find((x) => x.description === "Serviço A"); const B = its.find((x) => x.description === "Serviço B");
    const r0 = await c.post(`/orders/${o.orderId}/executions`, { itemId: A.id });
    expect(r0.status).toBe(409); expect(r0.json.error).toBe("not_approved");
    await c.post(`/orders/${o.orderId}/estimate/decisions`, { customerName: "Maria", decisions: [{ itemId: A.id, decision: "approved" }, { itemId: B.id, decision: "rejected", justification: "não quero" }] });
    expect((await c.post(`/orders/${o.orderId}/executions`, { itemId: A.id })).status).toBe(201);
    expect((await c.post(`/orders/${o.orderId}/executions`, { itemId: A.id })).status).toBe(409); // duplicado
    expect((await c.post(`/orders/${o.orderId}/executions`, { itemId: B.id })).status).toBe(409); // recusado
  });

  it("serviço adicional sem aprovação é bloqueado; exceção só com política, permissão, justificativa e evidência", async () => {
    const { t, c } = await setup();
    const o = await mkOrder(c);
    const extra = (over = {}) => ({ description: "Trocar mangueira", amountCents: 8000, exception: { justification: "Vazamento detectado durante o serviço, risco de pane.", evidenceAttachmentId: "00000000-0000-4000-8000-000000000000", ...over } });
    // sem política habilitada
    expect((await c.post(`/orders/${o.orderId}/executions`, extra())).json.error).toBe("not_approved");
    expect((await c.put("/execution-policy", { enabled: true, maxCents: 10000 })).status).toBe(200);
    // evidência inexistente
    expect((await c.post(`/orders/${o.orderId}/executions`, extra())).json.error).toBe("evidence_required");
    const up = await upload(c, o.orderId, PNG);
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    // justificativa curta
    expect((await c.post(`/orders/${o.orderId}/executions`, extra({ evidenceAttachmentId: up.json.id, justification: "curta" }))).status).toBe(422);
    // acima do teto
    const over = extra({ evidenceAttachmentId: up.json.id }); over.amountCents = 20000;
    expect((await c.post(`/orders/${o.orderId}/executions`, over)).json.error).toBe("exception_over_limit");
    // ok
    const ok = await c.post(`/orders/${o.orderId}/executions`, extra({ evidenceAttachmentId: up.json.id }));
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    const row = await ownerSql("select exception from service_executions where id = $1", [ok.json.id]);
    expect(row[0].exception.authorizedBy).toBe(t.owners.userId);
    expect(row[0].exception.justification.length).toBeGreaterThan(20);
    // sem permissão de exceção (atendente)
    const inv = await c.post("/members/invite", { email: `att-${t.slug}@example.test`, roleKey: "attendant", allUnits: true });
    const att = new Client(h, "10.21.0.1");
    await att.post("/auth/invite/accept", { token: inv.json.devToken, password: "Outra-Senha-456!" });
    await att.post("/auth/login", { email: `att-${t.slug}@example.test`, password: "Outra-Senha-456!", tenantSlug: t.slug });
    expect((await att.post(`/orders/${o.orderId}/executions`, extra({ evidenceAttachmentId: up.json.id }))).status).toBe(403);
  });
});

describe("C7 uploads e URL assinada", () => {
  it("valida tamanho, MIME e magic bytes", async () => {
    const { c } = await setup();
    const o = await mkOrder(c);
    expect((await upload(c, o.orderId, PNG, "image/png")).status).toBe(201);
    expect((await upload(c, o.orderId, PNG, "image/jpeg")).json.error).toBe("mime_mismatch");
    expect((await upload(c, o.orderId, new TextEncoder().encode("<script>alert(1)</script>"), "image/png")).json.error).toBe("unsupported_file_type");
    expect((await upload(c, o.orderId, new TextEncoder().encode("MZ\x90\x00 executavel"), "image/png")).json.error).toBe("unsupported_file_type");
    const big = new Uint8Array(10 * 1024 * 1024 + 1); big.set(PNG);
    expect((await upload(c, o.orderId, big, "image/png")).json.error).toBe("file_too_large");
    expect((await upload(c, o.orderId, new Uint8Array(0), "image/png")).status).toBe(422);
  });

  it("arquivo nunca é público: sem assinatura/assinatura inválida/expirada/outro tenant = negado", async () => {
    const A = await setup(); const B = await setup();
    const o = await mkOrder(A.c);
    const up = await upload(A.c, o.orderId, PNG);
    const list = await A.c.get(`/orders/${o.orderId}/attachments`);
    const url = list.json.attachments[0].url as string;
    expect(url).toContain("sig=");
    expect((await new Client(h).get(url)).status).toBe(200);          // assinatura válida
    expect((await new Client(h).get(url.split("?")[0]!)).status).toBe(403);
    expect((await new Client(h).get(url.replace(/sig=([0-9a-f])/, (_m, ch) => `sig=${ch === "0" ? "1" : "0"}`))).status).toBe(403);
    const exp = Number(/exp=(\d+)/.exec(url)![1]);
    expect(exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300);
    const { signFileUrl } = await import("../src/storage");
    const expired = await signFileUrl(h.config.encryptionKey, A.t.tenantId, up.json.id, 60, Date.now() - 120_000);
    expect((await new Client(h).get(expired)).status).toBe(403);
    // troca de tenant na URL invalida a assinatura
    expect((await new Client(h).get(url.replace(A.t.tenantId, B.t.tenantId))).status).toBe(403);
    // B não lista anexos da OS de A
    expect((await B.c.get(`/orders/${o.orderId}/attachments`)).status).toBe(404);
    const r = await new Client(h).get(url);
    void r;
  });

  it("anexo não pode ser apagado/alterado pela aplicação (append-only por privilégio)", async () => {
    const { t, c } = await setup();
    const o = await mkOrder(c);
    await upload(c, o.orderId, PNG);
    await expect(h.db.tx({ actor: "tenant", tenantId: t.tenantId, userId: t.owners.userId, unitScope: "all" }, (q) => q.query("delete from attachments"))).rejects.toThrow(/permission denied/);
  });
});

describe("C8 vistoria e termo de entrada", () => {
  it("confirma vistoria, gera PDF válido, armazena e torna a vistoria imutável", async () => {
    const { c } = await setup();
    const o = await mkOrder(c);
    expect((await c.put(`/orders/${o.orderId}/inspection`, { km: 45210, fuelLevel: "half", notes: "Veículo sujo" })).status).toBe(200);
    expect((await c.post(`/orders/${o.orderId}/inspection/marks`, { area: "Para-choque dianteiro", kind: "scratch", note: "Arranhão leve" })).status).toBe(201);
    const conf = await c.post(`/orders/${o.orderId}/inspection/confirm`, { confirmedByName: "Maria Cliente" });
    expect(conf.status, JSON.stringify(conf.json)).toBe(201);
    const file = await new Client(h).req("GET", conf.json.termUrl);
    expect(file.status).toBe(200);
    const stored = await h.storage.get([...h.storage.files.keys()].find((k) => k.includes(conf.json.termAttachmentId))!);
    expect(String.fromCharCode(...stored!.slice(0, 5))).toBe("%PDF-");
    expect((await c.get(`/orders/${o.orderId}`)).json.inspection.confirmed_at).toBeTruthy();
    // imutável após confirmação
    expect((await c.put(`/orders/${o.orderId}/inspection`, { km: 1 })).status).toBe(409);
    expect((await c.post(`/orders/${o.orderId}/inspection/marks`, { area: "Capô", kind: "dent" })).status).toBe(409);
    expect((await c.post(`/orders/${o.orderId}/inspection/confirm`, { confirmedByName: "Maria Cliente" })).status).toBe(409);
  });
});

describe("C9 busca", () => {
  it("encontra por placa, telefone, nome e número da OS", async () => {
    const { c } = await setup({ units: 1 });
    const o = await mkOrder(c, "SRC1A23");
    expect((await c.get("/search?q=src-1a23")).json.vehicles).toHaveLength(1);
    expect((await c.get("/search?q=SRC")).json.vehicles.length).toBeGreaterThanOrEqual(1);
    expect((await c.get("/search?q=71999991234")).json.customers.length).toBeGreaterThanOrEqual(1);
    expect((await c.get("/search?q=(71)%2099999-1234")).json.customers.length).toBeGreaterThanOrEqual(1);
    expect((await c.get("/search?q=Cliente")).json.customers.length).toBeGreaterThanOrEqual(1);
    expect((await c.get(`/search?q=${o.number}`)).json.orders.some((x: any) => x.id === o.orderId)).toBe(true);
    expect((await c.get("/search?q=x")).status).toBe(422);
  });

  it("p95 < 300 ms com 10k clientes (ambiente local de teste)", async () => {
    const { t, c } = await setup({ units: 1 });
    await ownerSql(
      `insert into customers (tenant_id, name, phone_e164)
       select $1, 'Cliente ' || md5(g::text), '+5571' || lpad((900000000 + g)::text, 9, '0') from generate_series(1, 10000) g`,
      [t.tenantId],
    );
    await ownerSql(
      `insert into vehicles (tenant_id, customer_id, plate)
       select $1, id, 'AAA' || lpad((row_number() over ())::text, 4, '0') from (select id from customers where tenant_id = $1 limit 3000) s`,
      [t.tenantId],
    );
    await ownerSql("analyze customers");
    const queries = ["Cliente a1b", "71900000123", "(71) 90000-5000", "AAA0012", "AAA00", "12", "Cliente 00"];
    const times: number[] = [];
    for (let i = 0; i < 120; i++) {
      const q = encodeURIComponent(queries[i % queries.length]!);
      const t0 = performance.now();
      const r = await c.get(`/search?q=${q}`);
      times.push(performance.now() - t0);
      expect(r.status).toBe(200);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.log(`busca p95=${p95.toFixed(1)}ms mediana=${times[60]!.toFixed(1)}ms (10k clientes)`);
    expect(p95).toBeLessThan(300);
  });
});

describe("Permissões e escopo", () => {
  it("mecânico vê OS mas não cria cliente nem publica orçamento; escopo de unidade limita OS", async () => {
    const { t, c } = await setup({ units: 2 });
    const oA = await mkOrder(c, "ESC1A11", t.unitIds[0]);
    const oB = await mkOrder(c, "ESC2B22", t.unitIds[1]);
    const inv = await c.post("/members/invite", { email: `mec-${t.slug}@example.test`, roleKey: "mechanic", unitIds: [t.unitIds[0]] });
    const m = new Client(h, "10.22.0.1");
    await m.post("/auth/invite/accept", { token: inv.json.devToken, password: "Outra-Senha-456!" });
    expect((await m.post("/auth/login", { email: `mec-${t.slug}@example.test`, password: "Outra-Senha-456!", tenantSlug: t.slug })).status).toBe(200);
    expect((await m.post("/customers", { name: "Fulano" })).json.error).toBe("permission_denied");
    expect((await m.post(`/orders/${oA.orderId}/estimate/publish`)).json.error).toBe("permission_denied");
    expect((await m.get(`/orders/${oA.orderId}`)).status).toBe(200);
    expect((await m.get(`/orders/${oB.orderId}`)).status).toBe(404); // fora do escopo de unidade
  });
});
