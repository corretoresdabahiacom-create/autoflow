import { MAX_WEBHOOK_ATTEMPTS, backoffSeconds } from "@autoflow/shared";
import { sha256Hex } from "./crypto";
import type { Q } from "./db";
import { setConsent } from "./routes/crm";
import { applyInvoicePaid } from "./routes/billing";
import { settleCore } from "./routes/finance";
import type { Deps } from "./types";

export interface IncomingEvent { eventId: string; type: string; payload: Record<string, unknown> }
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const STOP_WORDS = new Set(["parar", "pare", "sair", "stop", "cancelar", "descadastrar"]);

/** Persiste cada evento com (provider, event_id) único: replay NÃO repete o efeito. Eventos novos são processados na hora. */
export async function ingestEvents(deps: Deps, provider: string, events: IncomingEvent[]): Promise<{ received: number; duplicates: number }> {
  let received = 0, duplicates = 0;
  for (const e of events) {
    const row = await deps.db.tx({ actor: "platform" }, (q) => q.one<{ id: string }>("insert into webhook_events (provider, event_id, event_type, payload) values ($1,$2,$3,$4) on conflict (provider, event_id) do nothing returning id", [provider, e.eventId.slice(0, 200), e.type, JSON.stringify(e.payload)]));
    if (!row) { duplicates++; continue; }
    received++; await processEvent(deps, Number(row.id));
  }
  return { received, duplicates };
}

/** Processa um evento; falha => retry com backoff; esgotadas as tentativas => DLQ ('dead'), reprocessável. */
export async function processEvent(deps: Deps, id: number): Promise<"processed" | "failed" | "dead" | "skipped"> {
  const ev = await deps.db.tx({ actor: "platform" }, (q) => q.one<{ provider: string; event_type: string; payload: Record<string, unknown>; status: string; attempts: number }>("select provider, event_type, payload, status, attempts from webhook_events where id = $1 for update", [id]));
  if (!ev || ev.status === "processed" || ev.status === "ignored") return "skipped";
  try {
    const tenantId = await handle(deps, ev.provider, ev.event_type, ev.payload);
    await deps.db.tx({ actor: "platform" }, (q) => q.query("update webhook_events set status = case when $2::uuid is null and $3 then 'ignored' else 'processed' end, tenant_id = $2, processed_at = now(), last_error = null, attempts = attempts + 1 where id = $1", [id, tenantId, tenantId === null]));
    return "processed";
  } catch (e) {
    const attempts = ev.attempts + 1; const dead = attempts >= MAX_WEBHOOK_ATTEMPTS;
    await deps.db.tx({ actor: "platform" }, (q) => q.query("update webhook_events set status = $2, attempts = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5::int) where id = $1", [id, dead ? "dead" : "failed", attempts, (e as Error).message.slice(0, 120), backoffSeconds(attempts)]));
    return dead ? "dead" : "failed";
  }
}

/** Reprocessa eventos 'failed' vencidos (job) — ou um específico (reprocessamento manual da DLQ zera tentativas). */
export async function retryDue(deps: Deps): Promise<number> {
  const ids = await deps.db.tx({ actor: "platform" }, (q) => q.many<{ id: string }>("select id from webhook_events where status = 'failed' and next_attempt_at <= now() order by id limit 100"));
  for (const x of ids) await processEvent(deps, Number(x.id));
  return ids.length;
}
export async function reprocessDead(deps: Deps, id: number): Promise<string> {
  const ok = await deps.db.tx({ actor: "platform" }, (q) => q.query("update webhook_events set status = 'failed', attempts = 0, last_error = null, next_attempt_at = now() where id = $1 and status in ('dead','failed')", [id]));
  if (ok.rowCount !== 1) return "not_found";
  return processEvent(deps, id);
}

const ref = (r: unknown, prefix: "chg" | "inv") => new RegExp(`^${prefix}\\.(${UUID})\\.(${UUID})$`, "i").exec(String(r ?? ""));

/** Retorna o tenant afetado (ou null se não houver nada a fazer). Lança para falhas (retry/DLQ). */
async function handle(deps: Deps, provider: string, type: string, p: Record<string, unknown>): Promise<string | null> {
  if (provider === "whatsapp") return handleWhatsApp(deps, type, p);
  if (provider === "sandbox_payments" || provider === "payments") {
    if (type === "invoice.paid") {
      const m = ref(p.external_reference, "inv"); if (!m) throw new Error("bad_reference");
      await deps.db.tx({ actor: "platform" }, (q) => applyInvoicePaid(q, m[1]!, m[2]!, String(p.charge_id ?? "")));
      return m[1]!;
    }
    if (type === "payment.paid" || type === "payment.failed") {
      const m = ref(p.external_reference, "chg"); if (!m) throw new Error("bad_reference");
      const tenantId = m[1]!, chargeId = m[2]!;
      await deps.db.tx({ actor: "tenant", tenantId, unitScope: "all" }, async (q) => {
        const ch = await q.one<{ id: string; status: string; amount_cents: string; principal_cents: string; installment_id: string; wallet_id: string; method: "pix" | "boleto" | "card"; quoted_on: string; provider_charge_id: string }>("select id, status, amount_cents, principal_cents, installment_id, wallet_id, method, quoted_on::text quoted_on, provider_charge_id from payment_charges where id = $1 for update", [chargeId]);
        if (!ch || ch.provider_charge_id !== String(p.charge_id)) throw new Error("charge_not_found");
        if (ch.status !== "pending") return; // idempotente: já tratada
        if (type === "payment.failed") { await q.query("update payment_charges set status = 'failed' where id = $1", [chargeId]); return; }
        if (Number(p.amount_cents) !== Number(ch.amount_cents)) throw new Error("amount_mismatch");
        const key = `pay:${ch.id}`;
        const s = await settleCore(q, { tenantId, userId: null, requestId: "webhook" }, "receipt", { walletId: ch.wallet_id, settledOn: ch.quoted_on, method: ch.method, allocations: [{ installmentId: ch.installment_id, principalCents: Number(ch.principal_cents) }], waiveCharges: false }, key, await sha256Hex(key));
        await q.query("update payment_charges set status = 'paid', paid_at = now(), settlement_id = $2 where id = $1", [chargeId, s.id]);
      });
      return tenantId;
    }
  }
  return null;
}

async function handleWhatsApp(deps: Deps, type: string, p: Record<string, unknown>): Promise<string | null> {
  const phoneId = String(p.phoneNumberId ?? "");
  const tenantId = (await deps.db.tx({ actor: "platform" }, (q) => q.one<{ t: string | null }>("select af.wa_tenant_for_phone($1) t", [phoneId])))?.t ?? null;
  if (!tenantId) return null; // número não conectado a nenhum tenant: ignorado
  await deps.db.tx({ actor: "tenant", tenantId, unitScope: "all" }, async (q: Q) => {
    if (type === "status") {
      const st = String(p.status);
      const map: Record<string, string> = { sent: "sent", delivered: "delivered", read: "read", failed: "failed" };
      if (!map[st]) return;
      await q.query("update wa_messages set status = $2, error = $3, updated_at = now() where provider_message_id = $1 and not (status = 'read') and not (status = 'delivered' and $2 = 'sent')", [String(p.id), map[st], st === "failed" ? String(p.error ?? "failed").slice(0, 120) : null]);
    } else if (type === "inbound") {
      const word = String(p.text ?? "").trim().toLowerCase();
      const from = `+${String(p.from ?? "").replace(/\D/g, "")}`;
      const cust = await q.many<{ id: string }>("select id from customers where phone_e164 = $1", [from]);
      await q.query("insert into wa_messages (tenant_id, customer_id, direction, to_phone, provider_message_id, status) values ($1,$2,'in',$3,$4,'received') on conflict do nothing", [tenantId, cust[0]?.id ?? null, from, String(p.id ?? "")]);
      if (STOP_WORDS.has(word)) { await q.query("select set_config('app.consent_source', 'whatsapp_stop', true)"); for (const c of cust) await setConsent(q, tenantId, c.id, false, "whatsapp_stop"); }
    }
  });
  return tenantId;
}
