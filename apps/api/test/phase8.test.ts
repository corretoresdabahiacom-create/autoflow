import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../src/crypto";
import { processOutbox } from "../src/outbox";
import { UnconfiguredPayments } from "../src/providers";
import { runBilling } from "../src/routes/billing";
import { reprocessDead } from "../src/webhooks";
import { Client, type Harness, type SeededTenant, PW, loginOwner, makeHarness, ownerSql, seedTenant, uniq } from "./harness";
import { hashPassword } from "../src/password";

let h: Harness;
beforeAll(async () => {
  h = makeHarness();
  Object.assign(h.config, process.env.DBG ? { logLevel: "info" } : {}, { metaAppSecret: "meta-app-secret", waVerifyToken: "verify-me" });
  await ownerSql("update plans set price_cents = case code when 'ESSENCIAL' then 5000 when 'PROFISSIONAL' then 10000 else 20000 end");
});
afterAll(async () => { await ownerSql("update plans set price_cents = 0"); await h.db.close(); });

let ipn = 1;
const nextIp = () => `10.88.${Math.floor(ipn / 250)}.${(ipn++ % 250) + 1}`;
const PHONE_ID = () => String(Math.floor(Math.random() * 9e12 + 1e12));
const rawPost = async (path: string, raw: string, headers: Record<string, string>) => {
  const r = await Promise.resolve(h.app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": nextIp(), ...headers }, body: raw }));
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};
const metaPost = async (body: unknown, sig?: string) => { const raw = JSON.stringify(body); return rawPost("/webhooks/whatsapp", raw, { "x-hub-signature-256": sig ?? `sha256=${await hmacSha256Hex("meta-app-secret", raw)}` }); };
const payPost = async (body: unknown, sig?: string) => { const raw = JSON.stringify(body); return rawPost("/webhooks/payments/sandbox", raw, { "x-sandbox-signature": sig ?? (await hmacSha256Hex(h.config.sandboxWebhookSecret!, raw)) }); };
const waEntry = (phoneId: string, v: Record<string, unknown>) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneId }, ...v } }] }] });

async function setup() {
  const t = await seedTenant(h); const c = await loginOwner(h, t, nextIp());
  const cu = await c.post("/customers", { name: "Maria Silva", phone: "(71) 99999-1234", email: "maria@example.test" });
  const ve = await c.post(`/customers/${cu.json.id}/vehicles`, { plate: `PTK${Math.floor(Math.random() * 9)}${"ABCDEFGHJK"[Math.floor(Math.random() * 10)]}${Math.floor(Math.random() * 90 + 10)}`, make: "VW" });
  const wallet = await c.post("/finance/wallets", { name: "Conta", kind: "bank", openingBalanceCents: 0 });
  const invoice = async (amount = 30000, count = 1) => {
    const o = await c.post("/orders", { customerId: cu.json.id, vehicleId: ve.json.id });
    await c.post(`/orders/${o.json.id}/estimate/items`, { description: "Serviço", category: "service", qty: 1, unitPriceCents: amount });
    await c.post(`/orders/${o.json.id}/estimate/publish`);
    const est = (await c.get(`/orders/${o.json.id}/estimate`)).json.versions.find((v: any) => v.status === "published");
    await c.post(`/orders/${o.json.id}/estimate/decisions`, { customerName: "Maria", decisions: est.items.map((i: any) => ({ itemId: i.id, decision: "approved" })) });
    await c.patch(`/orders/${o.json.id}`, { status: "delivered" });
    const inv = await c.post(`/orders/${o.json.id}/invoice`, { plan: { count, firstDueDate: "2030-01-10" } }); expect(inv.status, JSON.stringify(inv.json)).toBeLessThan(300);
    return (await c.get("/finance/receivables")).json.installments.filter((i: any) => i.docId === inv.json.id);
  };
  return { t, c, cu: cu.json.id as string, walletId: wallet.json.id as string, invoice };
}
async function addMember(t: SeededTenant, role: string) {
  const email = `${uniq("m")}@example.test`;
  const u = await ownerSql<{ id: string }>("insert into users (email, password_hash) values ($1,$2) returning id", [email, await hashPassword(PW, 10)]);
  const r = await ownerSql<{ id: string }>("select id from roles where tenant_id is null and key = $1", [role]);
  await ownerSql("insert into memberships (tenant_id, user_id, role_id, status, all_units) values ($1,$2,$3,'active',true)", [t.tenantId, u[0]!.id, r[0]!.id]);
  const cl = new Client(h, nextIp()); expect((await cl.post("/auth/login", { email, password: PW, tenantSlug: t.slug })).status).toBe(200); return cl;
}

describe("W1 assinatura de webhooks e replay", () => {
  it("WhatsApp: verificação do desafio, assinatura inválida/ausente rejeitada, replay não duplica", async () => {
    const s = await setup(); const phone = PHONE_ID();
    expect((await s.c.post("/integrations/whatsapp/connect", { phoneNumberId: phone, accessToken: "EAAG-token-123456" })).status).toBe(201);
    expect((await h.app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123")).status).toBe(200);
    expect((await h.app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=abc123")).status).toBe(403);
    const body = waEntry(phone, { messages: [{ id: "wamid.IN1", from: "5571999991234", type: "text", text: { body: "oi" } }] });
    expect((await metaPost(body, "sha256=deadbeef")).status).toBe(401);
    expect((await rawPost("/webhooks/whatsapp", JSON.stringify(body), {})).status).toBe(401);
    const r1 = await metaPost(body); expect(r1.json).toEqual({ received: 1, duplicates: 0 });
    const r2 = await metaPost(body); expect(r2.json).toEqual({ received: 0, duplicates: 1 });
    expect(await ownerSql("select 1 from wa_messages where tenant_id = $1 and direction = 'in'", [s.t.tenantId])).toHaveLength(1);
    expect(await ownerSql("select 1 from webhook_events where provider = 'whatsapp' and event_id = 'wamid.IN1'")).toHaveLength(1);
    await metaPost(waEntry("0000000000000", { messages: [{ id: "wamid.ORPHAN", from: "5571999991234", type: "text", text: { body: "oi" } }] })); // número sem tenant: ignorado
    expect((await ownerSql("select status from webhook_events where event_id = 'wamid.ORPHAN'"))[0].status).toBe("ignored");
  });
  it("pagamentos: assinatura inválida => 401; provedor errado => 401; corpo inválido => 422", async () => {
    expect((await payPost({ event_id: "x1", type: "payment.paid" }, "00")).status).toBe(401);
    const raw = JSON.stringify({ event_id: "x1", type: "payment.paid" });
    expect((await rawPost("/webhooks/payments/outro", raw, { "x-sandbox-signature": await hmacSha256Hex(h.config.sandboxWebhookSecret!, raw) })).status).toBe(401);
    expect((await payPost({ nada: true })).status).toBe(422);
    expect((await new UnconfiguredPayments().verifyWebhook()) === false).toBe(true);
    await expect(new UnconfiguredPayments().createCharge()).rejects.toMatchObject({ status: 503 });
  });
});

describe("W2 pagamento aprovado => recebimento idempotente no ledger", () => {
  it("cobrança Pix → webhook pago → 1 recebimento/alocação/ledger; replay e evento duplicado não repetem; valor divergente vai para falha", async () => {
    const s = await setup(); expect((await s.c.post("/integrations/payments/connect", { provider: "sandbox", apiKey: "sk_sandbox_123456" })).status).toBe(201);
    const [inst] = await s.invoice(30000);
    const ch = await s.c.post(`/finance/installments/${inst.id}/charge`, { method: "pix", walletId: s.walletId }); expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    expect(ch.json.amountCents).toBe(30000); expect(ch.json.checkoutUrl).toContain("sandbox.invalid");
    expect((await s.c.post(`/finance/installments/${inst.id}/charge`, { method: "pix", walletId: s.walletId })).status).toBe(409); // uma cobrança pendente por parcela
    const row = (await ownerSql<{ provider_charge_id: string }>("select provider_charge_id from payment_charges where id = $1", [ch.json.id]))[0]!;
    const ev = (id: string, over: Record<string, unknown> = {}) => ({ event_id: id, type: "payment.paid", charge_id: row.provider_charge_id, external_reference: `chg.${s.t.tenantId}.${ch.json.id}`, amount_cents: 30000, ...over });
    const bad = await payPost(ev("evt-wrong-amount", { amount_cents: 1 })); expect(bad.json.received).toBe(1);
    expect((await ownerSql("select status from webhook_events where event_id = 'evt-wrong-amount'"))[0].status).toBe("failed");
    expect((await ownerSql("select 1 from fin_settlements where tenant_id = $1", [s.t.tenantId]))).toHaveLength(0);
    expect((await payPost(ev("evt-ok-1"))).json).toEqual({ received: 1, duplicates: 0 });
    expect((await payPost(ev("evt-ok-1"))).json).toEqual({ received: 0, duplicates: 1 }); // replay do mesmo event_id
    await payPost(ev("evt-ok-2")); // outro event_id para a mesma cobrança (reenvio do provedor)
    expect(await ownerSql("select 1 from fin_settlements where tenant_id = $1", [s.t.tenantId])).toHaveLength(1);
    expect(await ownerSql("select 1 from fin_allocations where tenant_id = $1", [s.t.tenantId])).toHaveLength(1);
    expect((await ownerSql("select status, settlement_id from payment_charges where id = $1", [ch.json.id]))[0]).toMatchObject({ status: "paid" });
    const rec = (await s.c.get("/finance/receivables")).json.installments.find((i: any) => i.id === inst.id); expect(rec).toMatchObject({ status: "paid", paidCents: 30000 });
    const bal = await ownerSql<{ d: string }>("select coalesce(sum(case side when 'D' then amount_cents else -amount_cents end),0)::bigint d from ledger_entries where tenant_id = $1", [s.t.tenantId]); expect(Number(bal[0]!.d)).toBe(0);
    const w = (await s.c.get("/finance/wallets")).json.wallets.find((x: any) => x.id === s.walletId); expect(w.balanceCents ?? w.balance_cents).toBe(30000);
    expect((await s.c.post(`/finance/installments/${inst.id}/charge`, { method: "pix", walletId: s.walletId })).status).toBe(409); // já paga
  });
  it("falha de pagamento marca a cobrança e permite nova cobrança; sem conexão => 409; papel sem permissão => 403", async () => {
    const s = await setup(); const [inst] = await s.invoice(10000);
    expect((await s.c.post(`/finance/installments/${inst.id}/charge`, { method: "pix", walletId: s.walletId })).json.error).toBe("payments_not_connected");
    await s.c.post("/integrations/payments/connect", { provider: "sandbox", apiKey: "sk_sandbox_123456" });
    const ch = await s.c.post(`/finance/installments/${inst.id}/charge`, { method: "boleto", walletId: s.walletId });
    const pid = (await ownerSql<{ provider_charge_id: string }>("select provider_charge_id from payment_charges where id = $1", [ch.json.id]))[0]!.provider_charge_id;
    await payPost({ event_id: uniq("f"), type: "payment.failed", charge_id: pid, external_reference: `chg.${s.t.tenantId}.${ch.json.id}` });
    expect((await ownerSql("select status from payment_charges where id = $1", [ch.json.id]))[0].status).toBe("failed");
    expect((await s.c.post(`/finance/installments/${inst.id}/charge`, { method: "pix", walletId: s.walletId })).status).toBe(201);
    const mec = await addMember(s.t, "mechanic"); expect((await mec.post(`/finance/installments/${inst.id}/charge`, { method: "pix", walletId: s.walletId })).status).toBe(403);
    expect((await mec.get("/integrations")).status).toBe(403);
  });
  it("DLQ: evento que falha repetidamente vai para 'dead' e pode ser reprocessado", async () => {
    const id = uniq("dlq"); await payPost({ event_id: id, type: "payment.paid", charge_id: "x", external_reference: "lixo", amount_cents: 1 });
    for (let i = 0; i < 4; i++) await ownerSql("update webhook_events set next_attempt_at = now() where event_id = $1", [id]).then(async () => { const w = await ownerSql<{ id: string }>("select id from webhook_events where event_id = $1", [id]); const { processEvent } = await import("../src/webhooks"); await processEvent(h, Number(w[0]!.id)); });
    const w = (await ownerSql<{ id: string; status: string; attempts: number; last_error: string }>("select id, status, attempts, last_error from webhook_events where event_id = $1", [id]))[0]!;
    expect(w).toMatchObject({ status: "dead", attempts: 5, last_error: "bad_reference" });
    expect(await reprocessDead(h, Number(w.id))).toBe("failed"); // continua inválido: volta a falhar, sem efeito colateral
    expect(await reprocessDead(h, 999999999)).toBe("not_found");
  });
});

describe("W3 billing: inadimplência suspende sem apagar dados", () => {
  it("renovação → past_due → suspensão (dados preservados) → pagamento reativa; replay não avança o período duas vezes", async () => {
    const s = await setup(); await ownerSql("update subscriptions set current_period_end = now() + interval '2 days' where tenant_id = $1", [s.t.tenantId]);
    const now = new Date(); const r1 = await runBilling(h, now); expect(r1.invoicesCreated).toBeGreaterThanOrEqual(1);
    const bill = (await s.c.get("/billing")).json; expect(bill.invoices).toHaveLength(1); const inv = bill.invoices[0]; expect(inv).toMatchObject({ kind: "renewal", amount_cents: 20000, status: "open" });
    expect((await runBilling(h, now)).invoicesCreated).toBe(0); // idempotente
    const dueMs = new Date(inv.due_date).getTime();
    await runBilling(h, new Date(dueMs + 86400_000));
    expect((await s.c.get("/billing")).json.subscription.status).toBe("past_due"); expect((await s.c.get("/customers")).status).toBe(200); // carência: segue operando
    const sus = await runBilling(h, new Date(dueMs + 9 * 86400_000)); expect(sus.suspended).toBeGreaterThanOrEqual(1);
    expect((await ownerSql("select status, suspended_reason from tenants where id = $1", [s.t.tenantId]))[0]).toMatchObject({ status: "suspended", suspended_reason: "billing" });
    expect(await ownerSql("select 1 from customers where tenant_id = $1", [s.t.tenantId])).toHaveLength(1); // dados intactos
    expect((await s.c.get("/customers")).status).not.toBe(200);
    expect((await s.c.get("/billing")).status).toBe(200); // dono ainda enxerga a cobrança para pagar
    const co = await s.c.post(`/billing/invoices/${inv.id}/checkout`); expect(co.status, JSON.stringify(co.json)).toBe(200);
    const evt = { event_id: uniq("inv"), type: "invoice.paid", charge_id: co.json.chargeId, external_reference: `inv.${s.t.tenantId}.${inv.id}` };
    expect((await payPost(evt)).json.received).toBe(1);
    const after = (await ownerSql<any>("select s.status, s.current_period_end::date::text pe, t.status tstatus from subscriptions s join tenants t on t.id = s.tenant_id where s.tenant_id = $1", [s.t.tenantId]))[0];
    expect(after).toMatchObject({ status: "active", tstatus: "active" });
    await payPost({ ...evt, event_id: uniq("inv") }); // reenvio com outro event_id
    expect((await ownerSql<any>("select current_period_end::date::text pe from subscriptions where tenant_id = $1", [s.t.tenantId]))[0].pe).toBe(after.pe);
    expect((await s.c.get("/customers")).status).toBe(200);
  });
  it("upgrade proporcional (vale ao pagar), downgrade só na renovação, cancelamento no fim do período e retomada; só o dono", async () => {
    const s = await setup(); const adm = await addMember(s.t, "admin"); await ownerSql("update subscriptions set plan_id = (select id from plans where code = 'ESSENCIAL'), current_period_end = now() + interval '15 days' where tenant_id = $1", [s.t.tenantId]);
    const up = await s.c.post("/billing/plan", { planCode: "PREMIUM" }); expect(up.status, JSON.stringify(up.json)).toBe(200);
    expect(up.json.effective).toBe("on_payment"); expect(up.json.amountCents).toBeGreaterThan(0); expect(up.json.amountCents).toBeLessThan(15000);
    await payPost({ event_id: uniq("u"), type: "invoice.paid", charge_id: "c", external_reference: `inv.${s.t.tenantId}.${up.json.invoiceId}` });
    expect((await s.c.get("/billing")).json.subscription.plan).toBe("PREMIUM");
    expect((await s.c.post("/billing/plan", { planCode: "PREMIUM" })).status).toBe(409);
    expect((await s.c.post("/billing/plan", { planCode: "ESSENCIAL" })).json.effective).toBe("next_renewal");
    expect((await s.c.get("/billing")).json.subscription.plan).toBe("PREMIUM");
    expect((await s.c.post("/billing/plan", { planCode: "nao-existe" })).status).toBe(404);
    expect((await s.c.post("/billing/cancel")).json.effective).toBe("end_of_period");
    expect((await s.c.get("/billing")).json.subscription.cancel_at_period_end).toBe(true);
    expect((await s.c.post("/billing/resume")).status).toBe(200);
    await s.c.post("/billing/cancel"); await ownerSql("update subscriptions set current_period_end = now() - interval '1 day' where tenant_id = $1", [s.t.tenantId]);
    expect((await runBilling(h)).cancelled).toBeGreaterThanOrEqual(1);
    expect((await ownerSql("select status from tenants where id = $1", [s.t.tenantId]))[0].status).toBe("cancelled");
    expect(await ownerSql("select 1 from customers where tenant_id = $1", [s.t.tenantId])).toHaveLength(1);
    expect((await adm.get("/billing")).status).toBe(403);
  });
});

describe("W4 segredos por tenant: cifrados, rotação, desconexão", () => {
  it("segredo nunca em claro (banco/API/auditoria); rotação versiona; desconexão apaga o segredo e cancela envios pendentes", async () => {
    const s = await setup(); const phone = PHONE_ID(); const TOKEN = "EAAG-super-secret-token-9999";
    const con = await s.c.post("/integrations/whatsapp/connect", { phoneNumberId: phone, accessToken: TOKEN }); expect(con.status).toBe(201); expect(con.json.hint).toBe("…9999");
    expect((await s.c.post("/integrations/whatsapp/connect", { phoneNumberId: phone, accessToken: TOKEN })).status).toBe(409);
    const db = (await ownerSql<any>("select * from integration_connections where tenant_id = $1", [s.t.tenantId]))[0];
    expect(db.secret_enc).toMatch(/^v1\./); expect(JSON.stringify(db)).not.toContain(TOKEN);
    expect(JSON.stringify((await s.c.get("/integrations")).json)).not.toContain("super-secret"); expect(JSON.stringify((await s.c.get("/integrations")).json)).not.toContain("secret_enc");
    expect(JSON.stringify(await ownerSql("select * from audit_log where tenant_id = $1", [s.t.tenantId]))).not.toContain(TOKEN);
    const rot = await s.c.post("/integrations/whatsapp/rotate", { secret: "EAAG-new-token-0001" }); expect(rot.json).toMatchObject({ version: 2, hint: "…0001" });
    expect((await ownerSql<any>("select secret_enc from integration_connections where tenant_id = $1", [s.t.tenantId]))[0].secret_enc).not.toBe(db.secret_enc);
    expect((await s.c.post("/whatsapp/send", { customerId: s.cu, template: "os_pronta", category: "utility", params: ["João"] })).status).toBe(202);
    expect((await s.c.delete("/integrations/whatsapp")).status).toBe(200);
    const gone = (await ownerSql<any>("select status, secret_enc, secret_hint from integration_connections where tenant_id = $1", [s.t.tenantId]))[0]; expect(gone).toMatchObject({ status: "disconnected", secret_enc: null, secret_hint: null });
    expect((await ownerSql("select status, last_error from outbox where tenant_id = $1 and kind = 'whatsapp'", [s.t.tenantId]))[0]).toMatchObject({ status: "skipped", last_error: "disconnected" });
    expect((await s.c.delete("/integrations/whatsapp")).status).toBe(404); expect((await s.c.post("/integrations/whatsapp/rotate", { secret: "EAAG-xxxxxxxx" })).status).toBe(404);
    expect((await s.c.post("/whatsapp/send", { customerId: s.cu, template: "os_pronta", category: "utility" })).json.error).toBe("whatsapp_not_connected");
    expect((await s.c.post("/integrations/whatsapp/connect", { phoneNumberId: phone, accessToken: "EAAG-reconnect-0002" })).status).toBe(201); // reconexão
    await expect(ownerSql("update integration_connections set status = 'connected', secret_enc = null where tenant_id = $1 and status = 'disconnected'", [s.t.tenantId])).rejects.toThrow(); // constraint: conectado exige segredo
  });
  it("isolamento: tenant B não vê nem usa a conexão de A; só owner/admin gerenciam", async () => {
    const A = await setup(); const B = await setup(); await A.c.post("/integrations/payments/connect", { provider: "sandbox", apiKey: "sk_sandbox_AAAA1111" });
    expect((await B.c.get("/integrations")).json.connections).toHaveLength(0);
    const [inst] = await B.invoice(5000); expect((await B.c.post(`/finance/installments/${inst.id}/charge`, { method: "pix", walletId: B.walletId })).json.error).toBe("payments_not_connected");
    const att = await addMember(A.t, "attendant"); expect((await att.post("/integrations/whatsapp/connect", { phoneNumberId: "12345678", accessToken: "EAAG-xxxxxxxx" })).status).toBe(403);
  });
});

describe("W5 WhatsApp sandbox ponta a ponta", () => {
  it("envio por outbox (token decifrado só no envio) → status entregue/lido → STOP revoga marketing; marketing exige consentimento", async () => {
    const s = await setup(); const phone = PHONE_ID();
    await s.c.post("/integrations/whatsapp/connect", { phoneNumberId: phone, accessToken: "EAAG-e2e-token-7777" });
    const m = await s.c.post("/whatsapp/send", { customerId: s.cu, template: "os_pronta", category: "utility", params: ["Maria", "ABC1D23"] }); expect(m.status).toBe(202);
    expect((await s.c.post("/whatsapp/send", { customerId: s.cu, template: "promo_nov", category: "marketing" })).json.error).toBe("no_marketing_consent");
    expect((await s.c.post("/whatsapp/send", { customerId: s.cu, template: "Template Inválido!", category: "utility" })).status).toBe(422);
    expect((await processOutbox(h, s.t.tenantId)).sent).toBe(1);
    const sent = h.whatsapp.sent[h.whatsapp.sent.length - 1]!; expect(sent.conn).toEqual({ phoneNumberId: phone, token: "EAAG-e2e-token-7777" }); expect(sent.msg).toMatchObject({ to: "+5571999991234", template: "os_pronta", params: ["Maria", "ABC1D23"], lang: "pt_BR" });
    const row = (await ownerSql<any>("select status, provider_message_id from wa_messages where id = $1", [m.json.id]))[0]; expect(row.status).toBe("sent");
    await metaPost(waEntry(phone, { statuses: [{ id: row.provider_message_id, status: "delivered" }] }));
    await metaPost(waEntry(phone, { statuses: [{ id: row.provider_message_id, status: "read" }] }));
    await metaPost(waEntry(phone, { statuses: [{ id: row.provider_message_id, status: "sent" }] })); // fora de ordem: não regride
    expect((await ownerSql("select status from wa_messages where id = $1", [m.json.id]))[0].status).toBe("read");
    // falha do provedor => backoff, sem perder a mensagem
    h.whatsapp.failNext = true; const m2 = await s.c.post("/whatsapp/send", { customerId: s.cu, template: "lembrete", category: "utility" });
    expect((await processOutbox(h, s.t.tenantId)).failed).toBe(1); expect((await ownerSql("select status from wa_messages where id = $1", [m2.json.id]))[0].status).toBe("queued");
    // consentimento + STOP
    await s.c.post(`/crm/customers/${s.cu}/consent`, { optIn: true, source: "whatsapp" });
    const m3 = await s.c.post("/whatsapp/send", { customerId: s.cu, template: "promo_nov", category: "marketing" }); expect(m3.status).toBe(202);
    await metaPost(waEntry(phone, { messages: [{ id: "wamid.STOP1", from: "5571999991234", type: "text", text: { body: " PARAR " } }] }));
    expect((await ownerSql("select marketing_opt_in from customers where id = $1", [s.cu]))[0].marketing_opt_in).toBe(false);
    await ownerSql("update outbox set available_at = now() where tenant_id = $1", [s.t.tenantId]);
    await processOutbox(h, s.t.tenantId);
    expect((await ownerSql("select status, error from wa_messages where id = $1", [m3.json.id]))[0]).toMatchObject({ status: "failed", error: "opted_out" });
    const log = (await s.c.get(`/crm/customers/${s.cu}/consent-log`)).json.log.map((x: any) => `${x.action}:${x.source}`); expect(log[log.length - 1]).toBe("revoke:whatsapp_stop");
    expect((await s.c.get("/whatsapp/messages")).json.messages.length).toBeGreaterThanOrEqual(4);
  });
  it("Web Push: assinatura https, teste de envio e remoção", async () => {
    const s = await setup(); const sub = { endpoint: "https://push.example.test/abc", keys: { p256dh: "BPkey", auth: "authkey" } };
    expect((await s.c.post("/push/subscribe", { ...sub, endpoint: "http://inseguro.test/x" })).status).toBe(422);
    expect((await s.c.post("/push/subscribe", sub)).status).toBe(201); expect((await s.c.post("/push/test")).json.sent).toBe(1); expect(h.push.sent.length).toBeGreaterThan(0);
    expect((await s.c.delete("/push/subscribe", { endpoint: sub.endpoint })).status).toBe(200); expect((await s.c.post("/push/test")).json.sent).toBe(0);
  });
});
