import { INVOICE_LEAD_DAYS, dunning, nextPeriodEnd, prorateUpgrade } from "@autoflow/shared";
import { z } from "zod";
import { audit } from "../audit";
import type { Q } from "../db";
import { HttpError, conflict, notFound, parseJson } from "../http";
import type { Router } from "../router";
import type { Deps, TenantPrincipal } from "../types";
import { reprocessDead, retryDue } from "../webhooks";
import { tctx } from "./tenant";

const N = (v: unknown) => Number(v ?? 0);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Fatura paga (idempotente): avança o período, aplica upgrade e reativa tenant suspenso por inadimplência. Roda como ator 'platform'. */
export async function applyInvoicePaid(q: Q, tenantId: string, invoiceId: string, chargeId: string): Promise<void> {
  const inv = await q.one<{ id: string; kind: string; status: string; plan_id: string; period_end: string }>("select id, kind, status, plan_id, period_end::text period_end from subscription_invoices where tenant_id = $1 and id = $2 for update", [tenantId, invoiceId]);
  if (!inv) throw new Error("invoice_not_found");
  if (inv.status === "paid") return;
  if (inv.status === "void") throw new Error("invoice_void");
  await q.query("update subscription_invoices set status = 'paid', paid_at = now(), provider_charge_id = coalesce(nullif($3,''), provider_charge_id) where tenant_id = $1 and id = $2", [tenantId, invoiceId, chargeId]);
  if (inv.kind === "renewal") await q.query("update subscriptions set plan_id = $2, pending_plan_id = case when pending_plan_id = $2 then null else pending_plan_id end, current_period_end = $3::date, trial_ends_at = null where tenant_id = $1", [tenantId, inv.plan_id, inv.period_end]);
  else await q.query("update subscriptions set plan_id = $2, pending_plan_id = null where tenant_id = $1", [tenantId, inv.plan_id]);
  const open = await q.one<{ n: string }>("select count(*) n from subscription_invoices where tenant_id = $1 and status = 'open' and due_date < now()", [tenantId]);
  if (N(open!.n) === 0) {
    await q.query("update subscriptions set status = 'active', grace_until = null where tenant_id = $1 and status <> 'cancelled'", [tenantId]);
    await q.query("update tenants set status = 'active', suspended_reason = null, updated_at = now() where id = $1 and (status = 'trial' or (status = 'suspended' and suspended_reason = 'billing'))", [tenantId]);
  }
  await audit(q, { tenantId, actorType: "system", actorId: null, action: "billing.invoice.paid", entityType: "subscription_invoice", entityId: invoiceId, requestId: "webhook" });
}

/** Job de billing (agendado externamente; idempotente): faturas de renovação, inadimplência, suspensão (sem apagar dados), cancelamento no fim do período. */
export async function runBilling(deps: Deps, now = new Date()): Promise<{ invoicesCreated: number; pastDue: number; suspended: number; cancelled: number; webhookRetries: number }> {
  const out = { invoicesCreated: 0, pastDue: 0, suspended: 0, cancelled: 0, webhookRetries: 0 };
  await deps.db.tx({ actor: "platform" }, async (q) => {
    const subs = await q.many<any>(`select s.tenant_id, s.status, s.plan_id, s.pending_plan_id, s.trial_ends_at, s.current_period_end, s.cancel_at_period_end, s.grace_until, p.price_cents, p.billing_interval, pp.price_cents pending_price, pp.billing_interval pending_interval
      from subscriptions s join plans p on p.id = s.plan_id left join plans pp on pp.id = s.pending_plan_id where s.status in ('trial','active','past_due') order by s.tenant_id for update of s`);
    for (const s of subs) {
      const periodStart: Date | null = s.status === "trial" ? s.trial_ends_at : s.current_period_end;
      const toPlan = s.pending_plan_id && s.status !== "trial" ? { id: s.pending_plan_id, price: N(s.pending_price), interval: s.pending_interval } : { id: s.plan_id, price: N(s.price_cents), interval: s.billing_interval };
      if (periodStart) {
        if (s.cancel_at_period_end && s.status !== "trial" && periodStart.getTime() <= now.getTime()) {
          await q.query("update subscriptions set status = 'cancelled' where tenant_id = $1", [s.tenant_id]);
          await q.query("update tenants set status = 'cancelled', updated_at = now() where id = $1", [s.tenant_id]); out.cancelled++; continue;
        }
        const due = new Date(periodStart.getTime() - (s.status === "trial" ? 0 : INVOICE_LEAD_DAYS * 86400_000));
        if (!s.cancel_at_period_end && due.getTime() <= now.getTime()) {
          if (s.status === "trial" && toPlan.price === 0) { await q.query("update subscriptions set status = 'active', current_period_end = $2::date where tenant_id = $1", [s.tenant_id, nextPeriodEnd(iso(periodStart), toPlan.interval)]); }
          else if (toPlan.price > 0) {
            const x = await q.query("insert into subscription_invoices (tenant_id, kind, plan_id, period_start, period_end, amount_cents, due_date) values ($1,'renewal',$2,$3::date,$4::date,$5,$6) on conflict (tenant_id, kind, period_start) do nothing", [s.tenant_id, toPlan.id, iso(periodStart), nextPeriodEnd(iso(periodStart), toPlan.interval), toPlan.price, periodStart]);
            out.invoicesCreated += x.rowCount ?? 0;
          } else if (s.status !== "trial") { await q.query("update subscriptions set plan_id = $2, pending_plan_id = null, current_period_end = $3::date where tenant_id = $1", [s.tenant_id, toPlan.id, nextPeriodEnd(iso(periodStart), toPlan.interval)]); }
        }
      }
    }
    // Inadimplência: fatura aberta vencida => past_due (+carência) => suspensão. Dados NUNCA são apagados.
    const od = await q.many<any>("select s.tenant_id, s.status, s.grace_until, min(i.due_date) oldest from subscriptions s join subscription_invoices i on i.tenant_id = s.tenant_id and i.status = 'open' where s.status in ('trial','active','past_due') group by s.tenant_id, s.status, s.grace_until");
    for (const s of od) {
      const a = dunning({ status: s.status, oldestOpenDueMs: s.oldest.getTime(), graceUntilMs: s.grace_until?.getTime() ?? null, nowMs: now.getTime() });
      if (a.action === "past_due") { await q.query("update subscriptions set status = 'past_due', grace_until = $2 where tenant_id = $1", [s.tenant_id, new Date(a.graceUntilMs)]); out.pastDue++; }
      else if (a.action === "suspend") {
        await q.query("update subscriptions set status = 'suspended' where tenant_id = $1", [s.tenant_id]);
        await q.query("update tenants set status = 'suspended', suspended_reason = 'billing', updated_at = now() where id = $1", [s.tenant_id]);
        await audit(q, { tenantId: s.tenant_id, actorType: "system", actorId: null, action: "billing.suspend", entityType: "subscription", entityId: s.tenant_id, requestId: "billing-job" }); out.suspended++;
      }
    }
  });
  out.webhookRetries = await retryDue(deps);
  return out;
}

export function registerBillingRoutes(r: Router, deps: Deps): void {
  const B = { auth: "tenant", permission: "billing:manage", allowInactive: true } as const; // allowInactive: o dono precisa pagar para reativar
  const tx = <T>(p: TenantPrincipal, fn: (q: Q) => Promise<T>) => deps.db.tx(tctx(p), fn);
  const plat = <T>(fn: (q: Q) => Promise<T>) => deps.db.tx({ actor: "platform" }, fn);

  r.get("/billing", B, async (c) => {
    const p = c.get("tenant");
    return c.json(await tx(p, async (q) => ({
      subscription: await q.one("select s.status, s.trial_ends_at, s.current_period_end, s.cancel_at_period_end, s.grace_until, p.code plan, p.name plan_name, p.price_cents, p.billing_interval, pp.code pending_plan from subscriptions s join plans p on p.id = s.plan_id left join plans pp on pp.id = s.pending_plan_id"),
      invoices: await q.many("select id, kind, amount_cents, status, due_date, paid_at, period_start::text period_start, period_end::text period_end from subscription_invoices order by created_at desc limit 50"),
    })));
  });
  r.get("/billing/plans", B, async (c) => c.json({ plans: await tx(c.get("tenant"), (q) => q.many("select code, name, price_cents, billing_interval from plans where active order by price_cents")) }));

  r.post("/billing/plan", B, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, z.object({ planCode: z.string().regex(/^[A-Za-z0-9_-]{2,40}$/) }));
    return c.json(await plat(async (q) => {
      const s = await q.one<any>("select s.*, p.price_cents cur_price, p.id cur_plan from subscriptions s join plans p on p.id = s.plan_id where s.tenant_id = $1 for update of s", [p.tenantId]);
      if (!s || s.status === "cancelled") throw conflict("subscription_cancelled");
      const np = await q.one<{ id: string; price_cents: number }>("select id, price_cents from plans where code = $1 and active", [b.planCode]); if (!np) throw notFound("plan_not_found");
      if (np.id === s.plan_id) throw conflict("same_plan");
      const now = new Date();
      let result: Record<string, unknown>;
      if (s.status === "trial") { await q.query("update subscriptions set plan_id = $2, pending_plan_id = null where tenant_id = $1", [p.tenantId, np.id]); result = { effective: "now" }; }
      else if (np.price_cents > N(s.cur_price)) { // upgrade: vale quando a fatura proporcional for paga
        const amount = prorateUpgrade(N(s.cur_price), np.price_cents, iso(new Date(s.current_period_end.getTime() - 30 * 86400_000)), iso(s.current_period_end), now.toISOString());
        if (amount === 0) { await q.query("update subscriptions set plan_id = $2, pending_plan_id = null where tenant_id = $1", [p.tenantId, np.id]); result = { effective: "now" }; }
        else {
          const inv = await q.one<{ id: string }>("insert into subscription_invoices (tenant_id, kind, plan_id, period_start, period_end, amount_cents, due_date) values ($1,'upgrade',$2,$3::date,$4::date,$5,$6) on conflict (tenant_id, kind, period_start) do update set plan_id = excluded.plan_id, amount_cents = excluded.amount_cents where subscription_invoices.status = 'open' returning id", [p.tenantId, np.id, iso(now), iso(s.current_period_end), amount, new Date(now.getTime() + 3 * 86400_000)]);
          if (!inv) throw conflict("upgrade_already_paid_today");
          await q.query("update subscriptions set pending_plan_id = $2 where tenant_id = $1", [p.tenantId, np.id]); result = { effective: "on_payment", invoiceId: inv.id, amountCents: amount };
        }
      } else { await q.query("update subscriptions set pending_plan_id = $2 where tenant_id = $1", [p.tenantId, np.id]); result = { effective: "next_renewal" }; } // downgrade: só na renovação
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "billing.plan_change", entityType: "subscription", entityId: p.tenantId, requestId: c.get("requestId"), metadata: { to: b.planCode } });
      return result;
    }));
  });
  r.post("/billing/cancel", B, async (c) => {
    const p = c.get("tenant");
    await plat(async (q) => { await q.query("update subscriptions set cancel_at_period_end = true where tenant_id = $1 and status <> 'cancelled'", [p.tenantId]); await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "billing.cancel_scheduled", entityType: "subscription", entityId: p.tenantId, requestId: c.get("requestId") }); });
    return c.json({ ok: true, effective: "end_of_period" });
  });
  r.post("/billing/resume", B, async (c) => {
    const p = c.get("tenant");
    const x = await plat((q) => q.query("update subscriptions set cancel_at_period_end = false where tenant_id = $1 and status <> 'cancelled'", [p.tenantId]));
    if (x.rowCount !== 1) throw conflict("subscription_cancelled");
    return c.json({ ok: true });
  });
  r.post("/billing/invoices/:id/checkout", B, async (c) => {
    const p = c.get("tenant"); const id = z.string().uuid().parse(c.req.param("id"));
    const inv = await tx(p, (q) => q.one<{ id: string; amount_cents: number; status: string }>("select id, amount_cents, status from subscription_invoices where id = $1", [id]));
    if (!inv) throw notFound("invoice_not_found"); if (inv.status !== "open") throw conflict("invoice_not_open");
    const ch = await deps.payments.createCharge("platform", { amountCents: inv.amount_cents, method: "pix", description: "Assinatura AutoFlow", externalReference: `inv.${p.tenantId}.${inv.id}` });
    await plat((q) => q.query("update subscription_invoices set provider = $2, provider_charge_id = $3 where id = $1 and status = 'open'", [id, deps.payments.name, ch.providerChargeId]));
    return c.json({ checkoutUrl: ch.checkoutUrl, chargeId: ch.providerChargeId });
  });

  // ---- Plataforma: job de billing e DLQ de webhooks ----
  const PLAT = { auth: "platform", mfa: "recent" } as const;
  r.post("/platform/billing/run", PLAT, async (c) => c.json(await runBilling(deps)));
  r.get("/platform/webhooks", PLAT, async (c) => {
    const st = z.enum(["received", "processed", "failed", "dead", "ignored"]).default("dead").parse(c.req.query("status") ?? undefined);
    return c.json({ events: await plat((q) => q.many("select id, provider, event_id, event_type, status, attempts, last_error, received_at from webhook_events where status = $1 order by id desc limit 200", [st])) });
  });
  r.post("/platform/webhooks/:id/reprocess", PLAT, async (c) => c.json({ result: await reprocessDead(deps, z.coerce.number().int().positive().parse(c.req.param("id"))) }));
  void HttpError;
}
