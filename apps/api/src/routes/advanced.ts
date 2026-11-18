import {
  AUTOMATION_VARS, authorizationDue, automationGate, buildDre, checkLimit, claimCanMove, claimDeadline, claimIsClosed, commissionAdjustment, commissionAmount, decideAuthorization,
  findFreeSlot, hasFeature, insurerShare, payoutSplit, pickRule, renderParam, resolveEntitlements, waitlistFits, type ClaimStatus, type FeatureValue, type SubscriptionStatus,
} from "@autoflow/shared";
import { z } from "zod";
import { audit } from "../audit";
import type { Q } from "../db";
import { HttpError, conflict, notFound, parseJson } from "../http";
import type { Router } from "../router";
import type { Deps, TenantPrincipal } from "../types";
import { ensureChart, postTxn, sysAcc } from "./finance";
import { tctx } from "./tenant";

const uuid = z.string().uuid();
const N = (v: unknown) => Number(v ?? 0);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, "data inválida");
const ts = z.string().datetime({ offset: true });
const cents = z.number().int().min(0).max(100_000_000_00);
const idem = z.string().min(8).max(80);
const lock = (q: Q, key: string) => q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
const defaultUnit = async (q: Q, unitId?: string) => {
  const u = unitId ? await q.one<{ id: string }>("select id from units where id = $1", [unitId]) : await q.one<{ id: string }>("select id from units order by is_default desc, created_at limit 1");
  if (!u) throw new HttpError(403, "unit_not_allowed"); return u.id;
};

// ===== Automações: motor (job) =====
const WaCfg = z.object({ template: z.string().regex(/^[a-z0-9_]{1,200}$/), lang: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/).default("pt_BR"), params: z.array(z.string().max(200)).max(10).default([]) });
const NoteCfg = z.object({ text: z.string().trim().min(1).max(160) });
export const KILL_KEY = "automation_kill_switch";

async function entitlementsOf(q: Q, tenantId: string) {
  const sub = await q.one<{ status: SubscriptionStatus; plan_id: string }>("select status, plan_id from subscriptions where tenant_id = $1", [tenantId]);
  if (!sub) return null;
  const pf = Object.fromEntries((await q.many<{ feature_code: string; value: FeatureValue }>("select feature_code, value from plan_features where plan_id = $1", [sub.plan_id])).map((r) => [r.feature_code, r.value]));
  const of = Object.fromEntries((await q.many<{ feature_code: string; value: FeatureValue }>("select feature_code, value from tenant_feature_overrides where tenant_id = $1", [tenantId])).map((r) => [r.feature_code, r.value]));
  return resolveEntitlements(pf, of, sub.status);
}
const usedThisMonth = async (q: Q) => N((await q.one<{ n: string }>("select count(*)::bigint n from automation_runs where status = 'done' and created_at >= date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'"))!.n);

export interface AutomationResult { tenants: number; done: number; skipped: number; failed: number; blocked: Record<string, number> }
/** Job: processa eventos novos da linha do tempo para as regras ativas. Idempotente por (regra, evento) e serializado por tenant. */
export async function runAutomations(deps: Deps, opts: { tenantId?: string } = {}): Promise<AutomationResult> {
  const out: AutomationResult = { tenants: 0, done: 0, skipped: 0, failed: 0, blocked: {} };
  const { kill, tenants } = await deps.db.tx({ actor: "platform" }, async (q) => ({
    kill: (await q.one<{ on: boolean }>("select coalesce((value ->> 'on')::boolean, false) as on from platform_settings where key = $1", [KILL_KEY]))?.on ?? false,
    tenants: (await q.many<{ tenant_id: string }>("select distinct tenant_id from automation_rules where enabled and ($1::uuid is null or tenant_id = $1) order by 1", [opts.tenantId ?? null])).map((r) => r.tenant_id),
  }));
  for (const tenantId of tenants) {
    out.tenants++;
    const ctx = { actor: "tenant", tenantId, unitScope: "all" } as const;
    const gate0 = await deps.db.tx(ctx, async (q) => {
      const ent = await entitlementsOf(q, tenantId);
      const st = await q.one<{ enabled: boolean }>("select enabled from automation_settings");
      const g = automationGate({ platformKill: kill, tenantEnabled: st?.enabled ?? true, usedThisMonth: await usedThisMonth(q), limit: ent && typeof ent.values["automation.monthly"] === "number" ? (ent.values["automation.monthly"] as number) : ent?.values["automation.monthly"] === null ? null : 0 });
      const allowed = !!ent && hasFeature(ent, "automation");
      const reason = !allowed ? "feature_not_in_plan" : g.ok ? null : g.reason;
      if (reason) await audit(q, { tenantId, actorType: "system", action: "automation.blocked", entityType: "tenant", entityId: tenantId, metadata: { reason } });
      return reason;
    });
    if (gate0) { out.blocked[gate0] = (out.blocked[gate0] ?? 0) + 1; continue; }
    const rules = await deps.db.tx(ctx, (q) => q.many<{ id: string; version: number; trigger_kind: string; action: string; config: unknown; activated_at: Date }>("select id, version, trigger_kind, action, config, activated_at from automation_rules where enabled order by created_at"));
    for (const rule of rules) {
      const cands = await deps.db.tx(ctx, (q) => q.many<{ id: string; os_id: string; unit_id: string; number: number; customer_id: string; name: string; plate: string }>(
        `select t.id, t.os_id, t.unit_id, o.number, c.id customer_id, c.name, v.plate
           from os_timeline t join service_orders o on o.tenant_id = t.tenant_id and o.id = t.os_id
           join customers c on c.tenant_id = o.tenant_id and c.id = o.customer_id join vehicles v on v.tenant_id = o.tenant_id and v.id = o.vehicle_id
          where t.kind = $1 and t.created_at >= $2 and t.created_at > now() - interval '14 days'
            and not exists (select 1 from automation_runs r where r.rule_id = $3 and r.source_key = 'tl:' || t.id::text)
          order by t.created_at limit 100`, [rule.trigger_kind, rule.activated_at, rule.id]));
      for (const cd of cands) {
        const attempt = (final: { status: "failed"; detail: string } | null) => deps.db.tx(ctx, async (q) => {
          await lock(q, `automation:${tenantId}`); // serializa execuções do tenant: limite e idempotência exatos
          const ent = await entitlementsOf(q, tenantId); const lim = ent?.values["automation.monthly"];
          const g = automationGate({ platformKill: kill, tenantEnabled: (await q.one<{ enabled: boolean }>("select enabled from automation_settings"))?.enabled ?? true, usedThisMonth: await usedThisMonth(q), limit: typeof lim === "number" ? lim : lim === null ? null : 0 });
          if (!g.ok) return { blocked: g.reason } as const;
          if (!(await q.one("select 1 from automation_rules where id = $1 and enabled", [rule.id]))) return { blocked: "rule_disabled" } as const;
          if (await q.one("select 1 from automation_runs where rule_id = $1 and source_key = $2", [rule.id, `tl:${cd.id}`])) return { status: "dup" } as const;
          let status: "done" | "skipped" | "failed" = "done"; let detail: string | null = null;
          if (final) { status = final.status; detail = final.detail; }
          else if (rule.action === "internal_note") {
            const cfg = NoteCfg.parse(rule.config);
            const text = renderParam(cfg.text, { customer_first_name: cd.name.split(" ")[0] ?? "", os_number: String(cd.number), plate: cd.plate });
            await q.query("insert into os_timeline (tenant_id, unit_id, os_id, kind, title, visible_to_customer) values ($1,$2,$3,'automation.note',$4,false)", [tenantId, cd.unit_id, cd.os_id, text.slice(0, 160)]);
          } else {
            const cfg = WaCfg.parse(rule.config);
            const conn = await q.one("select 1 from integration_connections where kind = 'whatsapp' and status = 'connected'");
            const cu = await q.one<{ phone_e164: string }>("select phone_e164 from customers where id = $1", [cd.customer_id]);
            if (!conn || !cu?.phone_e164) { status = "skipped"; detail = !conn ? "whatsapp_not_connected" : "customer_without_phone"; }
            else {
              const vars = { customer_first_name: cd.name.split(" ")[0] ?? "", os_number: String(cd.number), plate: cd.plate };
              const params = cfg.params.map((x) => renderParam(x, vars));
              // Automação envia SOMENTE utilidade (acompanhamento da OS). Marketing exige consentimento e passa por campanhas.
              const m = await q.one<{ id: string }>("insert into wa_messages (tenant_id, customer_id, direction, category, template, to_phone) values ($1,$2,'out','utility',$3,$4) returning id", [tenantId, cd.customer_id, cfg.template, cu.phone_e164]);
              await q.query("insert into outbox (tenant_id, unit_id, os_id, kind, payload) values ($1,$2,$3,'whatsapp',$4)", [tenantId, cd.unit_id, cd.os_id, JSON.stringify({ waMessageId: m!.id, params, lang: cfg.lang })]);
            }
          }
          await q.query("insert into automation_runs (tenant_id, rule_id, rule_version, source_key, status, detail) values ($1,$2,$3,$4,$5,$6)", [tenantId, rule.id, rule.version, `tl:${cd.id}`, status, detail]);
          await audit(q, { tenantId, actorType: "system", action: "automation.run", entityType: "automation_rule", entityId: rule.id, metadata: { status, detail, source: `tl:${cd.id}`, version: rule.version } });
          return { status } as const;
        });
        let res: Awaited<ReturnType<typeof attempt>>;
        try { res = await attempt(null); } catch (e) { res = await attempt({ status: "failed", detail: String((e as Error).message ?? e).slice(0, 200) }); }
        if ("blocked" in res) { const why = String(res.blocked); out.blocked[why] = (out.blocked[why] ?? 0) + 1; break; }
        if (res.status === "done") out.done++; else if (res.status === "skipped") out.skipped++; else if (res.status === "failed") out.failed++;
      }
    }
  }
  return out;
}

const orderOf = async (q: Q, id: string) => { const o = await q.one<{ id: string; unit_id: string; status: string; number: number; delivered_at: Date | null }>("select id, unit_id, status, number, delivered_at from service_orders where id = $1", [id]); if (!o) throw notFound("order_not_found"); return o; };

export function registerAdvancedRoutes(r: Router, deps: Deps): void {
  const tx = <T>(p: TenantPrincipal, fn: (q: Q) => Promise<T>) => deps.db.tx(tctx(p), fn);
  const plat = <T>(fn: (q: Q) => Promise<T>) => deps.db.tx({ actor: "platform" }, fn);
  const INS_R = { auth: "tenant", permission: "insurers:read", feature: "insurers" } as const;
  const INS_W = { auth: "tenant", permission: "insurers:manage", feature: "insurers" } as const;
  const REP = { auth: "tenant", permission: "reports:advanced", feature: "advanced_reports" } as const;
  const COM_R = { auth: "tenant", permission: "commissions:read", feature: "team" } as const;
  const COM_W = { auth: "tenant", permission: "commissions:manage", feature: "team" } as const;
  const AG_R = { auth: "tenant", permission: "schedule:read", feature: "agenda" } as const;
  const AG_W = { auth: "tenant", permission: "schedule:manage", feature: "agenda" } as const;
  const AUTO = { auth: "tenant", permission: "automation:manage", feature: "automation" } as const;
  const PLAT = { auth: "platform", mfa: "recent" } as const;

  // ================= Seguradoras e sinistros =================
  r.post("/insurers", INS_W, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, z.object({ name: z.string().trim().min(2).max(120), doc: z.string().trim().max(20).optional(), phone: z.string().trim().max(30).optional(), email: z.string().trim().email().max(120).optional(), slaAuthorizationHours: z.number().int().min(1).max(720).default(48) }));
    const row = await tx(p, async (q) => {
      try {
        const x = await q.one<{ id: string }>("insert into insurers (tenant_id, name, doc, phone, email, sla_authorization_hours) values ($1,$2,$3,$4,$5,$6) returning id", [p.tenantId, b.name, b.doc ?? null, b.phone ?? null, b.email ?? null, b.slaAuthorizationHours]);
        await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "insurer.create", entityType: "insurer", entityId: x!.id, requestId: c.get("requestId") }); return x!;
      } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("insurer_exists"); throw e; }
    });
    return c.json(row, 201);
  });
  r.get("/insurers", INS_R, async (c) => c.json({ insurers: await tx(c.get("tenant"), (q) => q.many("select id, name, doc, phone, email, sla_authorization_hours, active from insurers order by name")) }));
  r.patch("/insurers/:id", INS_W, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ slaAuthorizationHours: z.number().int().min(1).max(720).optional(), active: z.boolean().optional(), phone: z.string().trim().max(30).optional(), email: z.string().trim().email().max(120).optional() }));
    await tx(p, async (q) => {
      const x = await q.one("update insurers set sla_authorization_hours = coalesce($2, sla_authorization_hours), active = coalesce($3, active), phone = coalesce($4, phone), email = coalesce($5, email) where id = $1 returning id", [id, b.slaAuthorizationHours ?? null, b.active ?? null, b.phone ?? null, b.email ?? null]);
      if (!x) throw notFound("insurer_not_found");
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "insurer.update", entityType: "insurer", entityId: id, requestId: c.get("requestId") });
    });
    return c.json({ ok: true });
  });

  const claimOf = async (q: Q, id: string) => { const x = await q.one<any>("select k.*, i.sla_authorization_hours sla from insurance_claims k join insurers i on i.tenant_id = k.tenant_id and i.id = k.insurer_id where k.id = $1 for update of k", [id]); if (!x) throw notFound("claim_not_found"); return x; };
  const ev = (q: Q, p: TenantPrincipal, claimId: string, kind: string, detail: string | null) => q.query("insert into claim_events (tenant_id, claim_id, kind, detail, created_by) values ($1,$2,$3,$4,$5)", [p.tenantId, claimId, kind, detail, p.userId]);
  const present = (k: any, now = Date.now()) => ({ id: k.id, osId: k.os_id, unitId: k.unit_id, insurerId: k.insurer_id, claimNo: k.claim_no, policyNo: k.policy_no, status: k.status as ClaimStatus, deductibleCents: N(k.deductible_cents),
    requestedCents: N(k.requested_cents), authorizedCents: N(k.authorized_cents), authorizationDueAt: k.authorization_due_at, deadline: claimDeadline(k.status, k.authorization_due_at ? new Date(k.authorization_due_at).getTime() : null, now), ...insurerShare(N(k.authorized_cents), N(k.deductible_cents)) });

  r.post("/orders/:id/claims", INS_W, async (c) => {
    const p = c.get("tenant"); const osId = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ insurerId: uuid, claimNo: z.string().regex(/^[A-Za-z0-9._/-]{3,40}$/), policyNo: z.string().trim().max(40).optional(), deductibleCents: cents.default(0), requestedCents: cents.default(0) }));
    const out = await tx(p, async (q) => {
      const o = await orderOf(q, osId); if (o.status === "cancelled") throw conflict("order_cancelled");
      if (!(await q.one("select 1 from insurers where id = $1 and active", [b.insurerId]))) throw notFound("insurer_not_found");
      try {
        const k = await q.one<{ id: string }>("insert into insurance_claims (tenant_id, unit_id, os_id, insurer_id, claim_no, policy_no, deductible_cents, requested_cents, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id", [p.tenantId, o.unit_id, osId, b.insurerId, b.claimNo, b.policyNo ?? null, b.deductibleCents, b.requestedCents, p.userId]);
        await ev(q, p, k!.id, "opened", `Sinistro ${b.claimNo}`);
        await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "claim.open", entityType: "insurance_claim", entityId: k!.id, requestId: c.get("requestId") });
        return { id: k!.id };
      } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("claim_exists"); throw e; }
    });
    return c.json(out, 201);
  });
  r.get("/claims", INS_R, async (c) => {
    const p = c.get("tenant"); const dl = z.enum(["overdue", "due_soon", "ok", "none"]).optional().parse(c.req.query("deadline")); const st = z.enum(["opened", "awaiting_authorization", "authorized", "partially_authorized", "denied", "completed", "paid", "cancelled"]).optional().parse(c.req.query("status"));
    const rows = await tx(p, (q) => q.many<any>("select * from insurance_claims where ($1::text is null or status = $1) order by opened_at desc limit 500", [st ?? null]));
    const list = rows.map((k) => present(k)).filter((k) => !dl || k.deadline === dl);
    return c.json({ claims: list });
  });
  r.get("/claims/:id", INS_R, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    return c.json(await tx(p, async (q) => {
      const k = await q.one<any>("select * from insurance_claims where id = $1", [id]); if (!k) throw notFound("claim_not_found");
      return { claim: present(k), authorizations: await q.many("select version_no, requested_cents, authorized_cents, decision, code, note, created_at from claim_authorizations where claim_id = $1 order by version_no", [id]),
        events: await q.many("select kind, detail, created_at from claim_events where claim_id = $1 order by id", [id]) };
    }));
  });
  r.post("/claims/:id/request-authorization", INS_W, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id")); const b = await parseJson(c, z.object({ requestedCents: cents.refine((v) => v > 0, "valor deve ser positivo") }));
    return c.json(await tx(p, async (q) => {
      const k = await claimOf(q, id);
      if (!claimCanMove(k.status, "awaiting_authorization")) throw conflict("invalid_transition");
      if (b.requestedCents < N(k.authorized_cents)) throw conflict("requested_below_authorized");
      const due = new Date(authorizationDue(Date.now(), k.sla));
      await q.query("update insurance_claims set status = 'awaiting_authorization', requested_cents = $2, authorization_due_at = $3 where id = $1", [id, b.requestedCents, due]);
      await ev(q, p, id, "status", `Autorização solicitada: ${b.requestedCents} centavos; prazo ${due.toISOString()}`);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "claim.request_authorization", entityType: "insurance_claim", entityId: id, requestId: c.get("requestId") });
      return { status: "awaiting_authorization", authorizationDueAt: due };
    }));
  });
  r.post("/claims/:id/authorization", INS_W, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id")); const b = await parseJson(c, z.object({ authorizedCents: cents, code: z.string().trim().max(40).optional(), note: z.string().trim().max(500).optional() }));
    return c.json(await tx(p, async (q) => {
      const k = await claimOf(q, id); if (k.status !== "awaiting_authorization") throw conflict("not_awaiting_authorization");
      let decision; try { decision = decideAuthorization(N(k.requested_cents), b.authorizedCents); } catch { throw new HttpError(422, "authorized_exceeds_requested"); }
      const to: ClaimStatus = decision === "authorized" ? "authorized" : decision === "partial" ? "partially_authorized" : "denied";
      const ver = N((await q.one<{ v: string }>("select coalesce(max(version_no),0)::int + 1 v from claim_authorizations where claim_id = $1", [id]))!.v);
      await q.query("insert into claim_authorizations (tenant_id, claim_id, version_no, requested_cents, authorized_cents, decision, code, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [p.tenantId, id, ver, k.requested_cents, b.authorizedCents, decision, b.code ?? null, b.note ?? null, p.userId]);
      await q.query("update insurance_claims set status = $2, authorized_cents = $3, authorization_due_at = null where id = $1", [id, to, b.authorizedCents]);
      await ev(q, p, id, "authorization", `Decisão ${decision}: ${b.authorizedCents} de ${N(k.requested_cents)}`);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "claim.authorization", entityType: "insurance_claim", entityId: id, requestId: c.get("requestId"), metadata: { decision, version: ver } });
      return { status: to, decision, version: ver };
    }));
  });
  r.post("/claims/:id/status", INS_W, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id")); const b = await parseJson(c, z.object({ to: z.enum(["completed", "paid", "cancelled"]), reason: z.string().trim().max(200).optional() }));
    if (b.to === "cancelled" && (b.reason ?? "").length < 3) throw new HttpError(422, "reason_required");
    return c.json(await tx(p, async (q) => {
      const k = await claimOf(q, id); if (!claimCanMove(k.status, b.to)) throw conflict("invalid_transition");
      await q.query("update insurance_claims set status = $2, closed_at = case when $2 in ('paid','cancelled') then now() else closed_at end, authorization_due_at = null where id = $1", [id, b.to]);
      await ev(q, p, id, "status", `${k.status} → ${b.to}${b.reason ? `: ${b.reason}` : ""}`);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "claim.status", entityType: "insurance_claim", entityId: id, requestId: c.get("requestId"), metadata: { to: b.to, closed: claimIsClosed(b.to) } });
      return { status: b.to };
    }));
  });

  // ================= Relatórios avançados (todos derivados do ledger/estoque/tempo apontado) =================
  const range = (c: any) => z.object({ from: date, to: date }).parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const LEDGER_BY_UNIT = `select e.unit_id, a.id account_id, a.code, a.name, a.type,
      sum(case when a.type in ('revenue','financial') then (case e.side when 'C' then e.amount_cents else -e.amount_cents end) else (case e.side when 'D' then e.amount_cents else -e.amount_cents end) end)::bigint net
    from ledger_entries e join ledger_txns t on t.tenant_id = e.tenant_id and t.id = e.txn_id join fin_accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id
   where t.competence_date between $1 and $2 and a.type in ('revenue','deduction','direct_cost','expense','financial') group by e.unit_id, a.id, a.code, a.name, a.type`;
  const dreOf = (rows: { type: string; net: string }[]) => { const g = (t: string) => rows.filter((r) => r.type === t).reduce((s, r) => s + N(r.net), 0); return buildDre({ revenue: g("revenue"), deductions: g("deduction"), directCosts: g("direct_cost"), opex: g("expense"), financial: g("financial") }); };

  r.get("/reports/consolidated", REP, async (c) => {
    const p = c.get("tenant"); const { from, to } = range(c);
    return c.json(await tx(p, async (q) => {
      const units = await q.many<{ id: string; name: string; code: string }>("select id, name, code from units order by is_default desc, name"); // RLS: só unidades do escopo
      const led = await q.many<any>(LEDGER_BY_UNIT, [from, to]);
      const stock = await q.many<{ unit_id: string; v: string }>("select unit_id, sum(value_cents)::bigint v from stock_levels group by unit_id");
      const ord = await q.many<{ unit_id: string; opened: string; delivered: string }>("select unit_id, count(*) filter (where created_at::date between $1 and $2)::int opened, count(*) filter (where delivered_at::date between $1 and $2)::int delivered from service_orders group by unit_id", [from, to]);
      const per = units.map((u) => ({ unitId: u.id, name: u.name, code: u.code, dre: dreOf(led.filter((r) => r.unit_id === u.id)), stockValueCents: N(stock.find((s) => s.unit_id === u.id)?.v), ordersOpened: N(ord.find((o) => o.unit_id === u.id)?.opened), ordersDelivered: N(ord.find((o) => o.unit_id === u.id)?.delivered) }));
      const total = dreOf(led.filter((r) => units.some((u) => u.id === r.unit_id)));
      return { scope: p.unitScope, from, to, units: per, total: { dre: total, stockValueCents: per.reduce((s, u) => s + u.stockValueCents, 0), ordersOpened: per.reduce((s, u) => s + u.ordersOpened, 0), ordersDelivered: per.reduce((s, u) => s + u.ordersDelivered, 0) },
        label: "gerencial estimado; soma apenas as unidades do seu escopo", reconciliation: { sumOfUnitsOperatingResultCents: per.reduce((s, u) => s + u.dre.operatingResult, 0), totalOperatingResultCents: total.operatingResult } };
    }));
  });
  r.get("/reports/result-by-category", REP, async (c) => {
    const p = c.get("tenant"); const { from, to } = range(c);
    return c.json(await tx(p, async (q) => {
      const led = await q.many<any>(LEDGER_BY_UNIT, [from, to]);
      const byAcc = new Map<string, { code: string; name: string; type: string; totalCents: number; byUnit: Record<string, number> }>();
      for (const r0 of led) { const a: { code: string; name: string; type: string; totalCents: number; byUnit: Record<string, number> } = byAcc.get(r0.account_id) ?? { code: r0.code, name: r0.name, type: r0.type, totalCents: 0, byUnit: {} }; a.totalCents += N(r0.net); a.byUnit[r0.unit_id] = (a.byUnit[r0.unit_id] ?? 0) + N(r0.net); byAcc.set(r0.account_id, a); }
      const accounts = [...byAcc.values()].sort((x, y) => x.code.localeCompare(y.code));
      const types = ["revenue", "deduction", "direct_cost", "expense", "financial"].map((t) => ({ type: t, totalCents: accounts.filter((a) => a.type === t).reduce((s, a) => s + a.totalCents, 0) }));
      return { from, to, accounts, byType: types, dre: dreOf(led), label: "gerencial estimado (competência)" };
    }));
  });
  r.get("/reports/profit-by-order", REP, async (c) => {
    const p = c.get("tenant"); const { from, to } = range(c);
    return c.json(await tx(p, async (q) => {
      const rows = await q.many<any>(
        `select t.os_id, o.number, o.unit_id,
            coalesce(sum(case when a.type = 'revenue' then (case e.side when 'C' then e.amount_cents else -e.amount_cents end) end),0)::bigint revenue,
            coalesce(sum(case when a.type = 'deduction' then (case e.side when 'D' then e.amount_cents else -e.amount_cents end) end),0)::bigint deductions,
            coalesce(sum(case when a.type = 'direct_cost' then (case e.side when 'D' then e.amount_cents else -e.amount_cents end) end),0)::bigint direct
           from ledger_entries e join ledger_txns t on t.tenant_id = e.tenant_id and t.id = e.txn_id join fin_accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id
           join service_orders o on o.tenant_id = t.tenant_id and o.id = t.os_id
          where t.competence_date between $1 and $2 and t.os_id is not null and a.type in ('revenue','deduction','direct_cost') group by t.os_id, o.number, o.unit_id order by o.number`, [from, to]);
      const labor = await q.many<{ os_id: string; cost: string; minutes: string }>(
        `select t.os_id, coalesce(sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at)) * er.hourly_cost_cents / 3600),0)::bigint cost, coalesce(sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at))/60),0)::bigint minutes
           from task_time_entries e join production_tasks t on t.tenant_id = e.tenant_id and t.id = e.task_id left join employee_rates er on er.tenant_id = e.tenant_id and er.membership_id = e.membership_id where e.kind = 'work' group by t.os_id`);
      const orders = rows.map((r0) => { const l = labor.find((x) => x.os_id === r0.os_id); const net = N(r0.revenue) - N(r0.deductions);
        return { osId: r0.os_id, number: r0.number, unitId: r0.unit_id, netRevenueCents: net, directCostsCents: N(r0.direct), contributionMarginCents: net - N(r0.direct), laborCostCents: N(l?.cost), trackedMinutes: N(l?.minutes), marginAfterLaborCents: net - N(r0.direct) - N(l?.cost) }; });
      // Reconciliação com o ledger do período: (por OS) + (sem OS) = total do ledger.
      const tot = await q.many<{ type: string; os: boolean; net: string }>(
        `select a.type, (t.os_id is not null) os, sum(case when a.type in ('revenue') then (case e.side when 'C' then e.amount_cents else -e.amount_cents end) else (case e.side when 'D' then e.amount_cents else -e.amount_cents end) end)::bigint net
           from ledger_entries e join ledger_txns t on t.tenant_id = e.tenant_id and t.id = e.txn_id join fin_accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id
          where t.competence_date between $1 and $2 and a.type in ('revenue','deduction','direct_cost') group by a.type, (t.os_id is not null)`, [from, to]);
      const sumT = (type: string, os: boolean) => N(tot.find((x) => x.type === type && x.os === os)?.net);
      const rec = (type: string, field: "netRevenueCents" | "directCostsCents") => ({ byOrdersCents: orders.reduce((s, o) => s + (type === "revenue" ? o[field] + 0 : o[field]), 0), withoutOrderCents: sumT(type, false) });
      void rec;
      const revenueOrders = rows.reduce((s, r0) => s + N(r0.revenue), 0); const dedOrders = rows.reduce((s, r0) => s + N(r0.deductions), 0); const directOrders = rows.reduce((s, r0) => s + N(r0.direct), 0);
      return { from, to, orders, label: "margem de contribuição por OS (ledger) e após mão de obra apontada (estimada)",
        reconciliation: { revenue: { byOrdersCents: revenueOrders, withoutOrderCents: sumT("revenue", false), ledgerTotalCents: sumT("revenue", true) + sumT("revenue", false) },
          deductions: { byOrdersCents: dedOrders, withoutOrderCents: sumT("deduction", false), ledgerTotalCents: sumT("deduction", true) + sumT("deduction", false) },
          directCosts: { byOrdersCents: directOrders, withoutOrderCents: sumT("direct_cost", false), ledgerTotalCents: sumT("direct_cost", true) + sumT("direct_cost", false) } } };
    }));
  });
  r.get("/reports/productivity", REP, async (c) => {
    const p = c.get("tenant"); const { from, to } = range(c);
    return c.json(await tx(p, async (q) => {
      const t = await q.many<any>(
        `select e.membership_id, count(distinct e.task_id)::int tasks,
                coalesce(sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at))/60),0)::bigint minutes,
                coalesce(sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at)) * er.hourly_cost_cents / 3600),0)::bigint cost
           from task_time_entries e left join employee_rates er on er.tenant_id = e.tenant_id and er.membership_id = e.membership_id
          where e.kind = 'work' and e.membership_id is not null and (e.started_at at time zone 'America/Sao_Paulo')::date between $1 and $2 group by e.membership_id`, [from, to]);
      const d = await q.many<any>(
        `select assignee_membership_id m, count(*)::int done, count(*) filter (where due_at is null or done_at <= due_at)::int on_time
           from production_tasks where status = 'done' and assignee_membership_id is not null and (done_at at time zone 'America/Sao_Paulo')::date between $1 and $2 group by assignee_membership_id`, [from, to]);
      const ids = [...new Set([...t.map((x: any) => x.membership_id), ...d.map((x: any) => x.m)])];
      const names = ids.length ? await q.many<{ id: string; email: string }>("select m.id, u.email from memberships m join users u on u.id = m.user_id where m.id = any($1::uuid[])", [ids]) : [];
      const people = ids.map((id) => { const a = t.find((x: any) => x.membership_id === id); const b = d.find((x: any) => x.m === id);
        return { membershipId: id, name: names.find((n) => n.id === id)?.email ?? null, trackedMinutes: N(a?.minutes), laborCostCents: N(a?.cost), tasksWorked: N(a?.tasks), tasksDone: N(b?.done), tasksOnTime: N(b?.on_time),
          onTimeRate: N(b?.done) ? Math.round((N(b?.on_time) / N(b?.done)) * 1000) / 10 : null }; });
      return { from, to, people, totals: { trackedMinutes: people.reduce((s, x) => s + x.trackedMinutes, 0), laborCostCents: people.reduce((s, x) => s + x.laborCostCents, 0) }, label: "baseado em tempo apontado (tarefas) e custo/hora cadastrado" };
    }));
  });
  r.get("/reports/stock-valuation", REP, async (c) => {
    const p = c.get("tenant");
    return c.json(await tx(p, async (q) => {
      const units = await q.many<{ id: string; name: string }>("select id, name from units order by is_default desc, name");
      const lv = await q.many<{ unit_id: string; v: string; n: string }>("select unit_id, sum(value_cents)::bigint v, count(*)::int n from stock_levels group by unit_id");
      await ensureChart(q, p.tenantId); const inv = await sysAcc(q, "inventory");
      const lg = await q.many<{ unit_id: string; b: string }>("select unit_id, sum(case side when 'D' then amount_cents else -amount_cents end)::bigint b from ledger_entries where account_id = $1 group by unit_id", [inv]);
      const per = units.map((u) => { const s = N(lv.find((x) => x.unit_id === u.id)?.v); const l = N(lg.find((x) => x.unit_id === u.id)?.b); return { unitId: u.id, name: u.name, stockValueCents: s, ledgerInventoryCents: l, diffCents: s - l }; });
      return { units: per, totalDiffCents: per.reduce((s, u) => s + u.diffCents, 0), label: "valor do estoque (custo médio) × saldo da conta Estoque no ledger; diferença esperada = 0" };
    }));
  });

  // ================= Comissões e adiantamentos =================
  r.post("/commissions/rules", COM_W, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, z.object({ membershipId: uuid, basis: z.enum(["os_net_revenue", "os_margin"]), rateBps: z.number().int().min(1).max(10000), validFrom: ts.optional(), note: z.string().trim().max(200).optional() }));
    return c.json(await tx(p, async (q) => {
      if (!(await q.one("select 1 from memberships where id = $1", [b.membershipId]))) throw notFound("member_not_found");
      await lock(q, `commrule:${b.membershipId}`);
      const v = N((await q.one<{ v: string }>("select coalesce(max(version_no),0)::int + 1 v from commission_rules where membership_id = $1", [b.membershipId]))!.v);
      const x = await q.one<{ id: string }>("insert into commission_rules (tenant_id, membership_id, version_no, basis, rate_bps, valid_from, note, created_by) values ($1,$2,$3,$4,$5,coalesce($6::timestamptz, now()),$7,$8) returning id", [p.tenantId, b.membershipId, v, b.basis, b.rateBps, b.validFrom ?? null, b.note ?? null, p.userId]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "commission.rule", entityType: "commission_rule", entityId: x!.id, requestId: c.get("requestId"), metadata: { version: v, basis: b.basis, rateBps: b.rateBps } });
      return { id: x!.id, versionNo: v };
    }), 201);
  });
  r.get("/commissions/rules", COM_R, async (c) => c.json({ rules: await tx(c.get("tenant"), (q) => q.many("select id, membership_id, version_no, basis, rate_bps, valid_from, note, created_at from commission_rules order by membership_id, version_no")) }));

  r.post("/orders/:id/commissions/calculate", COM_W, async (c) => {
    const p = c.get("tenant"); const osId = uuid.parse(c.req.param("id"));
    return c.json(await tx(p, async (q) => {
      const o = await orderOf(q, osId); if (o.status !== "delivered" || !o.delivered_at) throw conflict("order_not_delivered");
      await q.query("select id from service_orders where id = $1 for update", [osId]); // serializa o cálculo da OS
      const led = await q.many<{ type: string; cr: string }>(
        `select a.type, sum(case e.side when 'C' then e.amount_cents else -e.amount_cents end)::bigint cr
           from ledger_entries e join ledger_txns t on t.tenant_id = e.tenant_id and t.id = e.txn_id join fin_accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id
          where t.os_id = $1 and a.type in ('revenue','deduction','direct_cost') group by a.type`, [osId]);
      const cr = (t: string) => N(led.find((x) => x.type === t)?.cr);
      const net = cr("revenue") + cr("deduction"); const direct = -cr("direct_cost"); const margin = net - direct;
      const members = await q.many<{ m: string }>(`select distinct m from (select e.membership_id m from task_time_entries e join production_tasks t on t.tenant_id = e.tenant_id and t.id = e.task_id where t.os_id = $1 and e.membership_id is not null
         union select assignee_membership_id from production_tasks where os_id = $1 and status = 'done' and assignee_membership_id is not null) x order by 1`, [osId]);
      const res: { membershipId: string; status: string; amountCents?: number; adjustmentCents?: number }[] = [];
      await ensureChart(q, p.tenantId); const exp = await sysAcc(q, "exp_commissions"); const pay = await sysAcc(q, "commissions_payable");
      for (const { m } of members) {
        const prior = await q.one<{ rule_id: string; basis: string; rate_bps: number }>("select e.rule_id, r.basis, r.rate_bps from commission_entries e join commission_rules r on r.tenant_id = e.tenant_id and r.id = e.rule_id where e.os_id = $1 and e.membership_id = $2 and e.kind = 'accrual'", [osId, m]);
        let rule: { id: string; basis: string; rate: number } | null;
        if (prior) rule = { id: prior.rule_id, basis: prior.basis, rate: prior.rate_bps }; // histórico: mantém a regra do lançamento original
        else {
          const rs = await q.many<{ id: string; version_no: number; valid_from: Date; basis: "os_net_revenue" | "os_margin"; rate_bps: number }>("select id, version_no, valid_from, basis, rate_bps from commission_rules where membership_id = $1", [m]);
          const pick = pickRule(rs.map((x) => ({ id: x.id, versionNo: x.version_no, validFromMs: x.valid_from.getTime(), basis: x.basis, rateBps: x.rate_bps })), o.delivered_at.getTime());
          rule = pick ? { id: pick.id, basis: pick.basis, rate: pick.rateBps } : null;
        }
        if (!rule) { res.push({ membershipId: m, status: "no_rule" }); continue; }
        const basis = rule.basis === "os_margin" ? margin : net; const due = commissionAmount(basis, rule.rate);
        const sofar = N((await q.one<{ s: string }>("select coalesce(sum(amount_cents),0)::bigint s from commission_entries where os_id = $1 and membership_id = $2", [osId, m]))!.s);
        if (!prior) {
          if (due === 0) { res.push({ membershipId: m, status: "zero" }); continue; }
          const txn = await postTxn(q, { tenantId: p.tenantId, unitId: o.unit_id, kind: "payable", description: `Comissão OS ${o.number}`, osId, userId: p.userId, entries: [{ account: exp, side: "D", amount: due }, { account: pay, side: "C", amount: due }] });
          await q.query("insert into commission_entries (tenant_id, unit_id, os_id, membership_id, rule_id, kind, basis_cents, rate_bps, amount_cents, txn_id, created_by) values ($1,$2,$3,$4,$5,'accrual',$6,$7,$8,$9,$10)", [p.tenantId, o.unit_id, osId, m, rule.id, basis, rule.rate, due, txn, p.userId]);
          res.push({ membershipId: m, status: "accrued", amountCents: due });
        } else {
          const delta = commissionAdjustment(sofar, due);
          if (delta === 0) { res.push({ membershipId: m, status: "unchanged", amountCents: sofar }); continue; }
          const txn = await postTxn(q, { tenantId: p.tenantId, unitId: o.unit_id, kind: "payable", description: `Ajuste de comissão OS ${o.number}`, osId, userId: p.userId, entries: delta > 0 ? [{ account: exp, side: "D", amount: delta }, { account: pay, side: "C", amount: delta }] : [{ account: pay, side: "D", amount: -delta }, { account: exp, side: "C", amount: -delta }] });
          await q.query("insert into commission_entries (tenant_id, unit_id, os_id, membership_id, rule_id, kind, basis_cents, rate_bps, amount_cents, txn_id, created_by) values ($1,$2,$3,$4,$5,'adjustment',$6,$7,$8,$9,$10)", [p.tenantId, o.unit_id, osId, m, rule.id, basis, rule.rate, delta, txn, p.userId]);
          res.push({ membershipId: m, status: "adjusted", adjustmentCents: delta });
        }
      }
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "commission.calculate", entityType: "service_order", entityId: osId, requestId: c.get("requestId") });
      return { osId, netRevenueCents: net, marginCents: margin, results: res, note: "Margem = receita líquida − custos diretos do ledger (mão de obra não incluída)." };
    }));
  });

  const balanceOf = async (q: Q, m: string) => {
    const a = await q.one<{ acc: string }>("select coalesce(sum(amount_cents),0)::bigint acc from commission_entries where membership_id = $1", [m]);
    const pp = await q.one<{ g: string; o: string }>("select coalesce(sum(gross_cents),0)::bigint g, coalesce(sum(advance_offset_cents),0)::bigint o from commission_payouts where membership_id = $1", [m]);
    const ad = await q.one<{ s: string }>("select coalesce(sum(amount_cents),0)::bigint s from commission_advances where membership_id = $1", [m]);
    const accrued = N(a!.acc); const paidGross = N(pp!.g); const advances = N(ad!.s); const offset = N(pp!.o);
    return { accruedCents: accrued, paidGrossCents: paidGross, payableCents: accrued - paidGross, advancesCents: advances, advancesOffsetCents: offset, outstandingAdvancesCents: advances - offset };
  };
  r.get("/commissions/balance", COM_R, async (c) => { const p = c.get("tenant"); const m = uuid.parse(c.req.query("membershipId")); return c.json({ membershipId: m, ...(await tx(p, (q) => balanceOf(q, m))) }); });
  r.get("/commissions/entries", COM_R, async (c) => {
    const p = c.get("tenant"); const m = c.req.query("membershipId") ? uuid.parse(c.req.query("membershipId")) : null;
    return c.json({ entries: await tx(p, (q) => q.many("select id, os_id, membership_id, rule_id, kind, basis_cents, rate_bps, amount_cents, created_at from commission_entries where ($1::uuid is null or membership_id = $1) order by id desc limit 500", [m])) });
  });
  r.post("/commissions/advances", COM_W, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, z.object({ membershipId: uuid, walletId: uuid, amountCents: cents.refine((v) => v > 0), idempotencyKey: idem, note: z.string().trim().max(200).optional(), unitId: uuid.optional() }));
    const out = await tx(p, async (q) => {
      await lock(q, `commmember:${b.membershipId}`);
      const prev = await q.one<{ id: string; membership_id: string; amount_cents: string }>("select id, membership_id, amount_cents from commission_advances where idempotency_key = $1", [b.idempotencyKey]);
      if (prev) { if (prev.membership_id !== b.membershipId || N(prev.amount_cents) !== b.amountCents) throw conflict("idempotency_key_reused"); return { id: prev.id, replayed: true }; }
      if (!(await q.one("select 1 from memberships where id = $1", [b.membershipId]))) throw notFound("member_not_found");
      const w = await q.one<{ account_id: string }>("select account_id from fin_wallets where id = $1 and active", [b.walletId]); if (!w) throw notFound("wallet_not_found");
      const unit = await defaultUnit(q, b.unitId); await ensureChart(q, p.tenantId);
      const txn = await postTxn(q, { tenantId: p.tenantId, unitId: unit, kind: "payment", description: "Adiantamento a colaborador", userId: p.userId, entries: [{ account: await sysAcc(q, "employee_advances"), side: "D", amount: b.amountCents }, { account: w.account_id, side: "C", amount: b.amountCents }] });
      const x = await q.one<{ id: string }>("insert into commission_advances (tenant_id, unit_id, membership_id, amount_cents, wallet_id, txn_id, note, idempotency_key, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id", [p.tenantId, unit, b.membershipId, b.amountCents, b.walletId, txn, b.note ?? null, b.idempotencyKey, p.userId]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "commission.advance", entityType: "commission_advance", entityId: x!.id, requestId: c.get("requestId") });
      return { id: x!.id, replayed: false };
    });
    return c.json(out, out.replayed ? 200 : 201);
  });
  r.post("/commissions/payouts", COM_W, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, z.object({ membershipId: uuid, walletId: uuid.optional(), grossCents: cents.refine((v) => v > 0).optional(), idempotencyKey: idem, unitId: uuid.optional() }));
    const out = await tx(p, async (q) => {
      await lock(q, `commmember:${b.membershipId}`);
      const prev = await q.one<any>("select id, membership_id, gross_cents, advance_offset_cents, net_cents from commission_payouts where idempotency_key = $1", [b.idempotencyKey]);
      if (prev) { if (prev.membership_id !== b.membershipId) throw conflict("idempotency_key_reused"); return { id: prev.id, grossCents: N(prev.gross_cents), advanceOffsetCents: N(prev.advance_offset_cents), netCents: N(prev.net_cents), replayed: true }; }
      const bal = await balanceOf(q, b.membershipId);
      const gross = b.grossCents ?? bal.payableCents; if (gross <= 0) throw conflict("nothing_to_pay"); if (gross > bal.payableCents) throw conflict("exceeds_payable");
      const sp = payoutSplit(gross, bal.outstandingAdvancesCents);
      if (sp.netCents > 0 && !b.walletId) throw new HttpError(422, "wallet_required");
      let walletAcc: string | null = null;
      if (sp.netCents > 0) { const w = await q.one<{ account_id: string }>("select account_id from fin_wallets where id = $1 and active", [b.walletId]); if (!w) throw notFound("wallet_not_found"); walletAcc = w.account_id; }
      const unit = await defaultUnit(q, b.unitId); await ensureChart(q, p.tenantId);
      const txn = await postTxn(q, { tenantId: p.tenantId, unitId: unit, kind: "payment", description: "Pagamento de comissão", userId: p.userId,
        entries: [{ account: await sysAcc(q, "commissions_payable"), side: "D", amount: gross }, ...(sp.offsetCents > 0 ? [{ account: await sysAcc(q, "employee_advances"), side: "C" as const, amount: sp.offsetCents }] : []), ...(walletAcc ? [{ account: walletAcc, side: "C" as const, amount: sp.netCents }] : [])] });
      const x = await q.one<{ id: string }>("insert into commission_payouts (tenant_id, unit_id, membership_id, gross_cents, advance_offset_cents, net_cents, wallet_id, txn_id, idempotency_key, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id", [p.tenantId, unit, b.membershipId, gross, sp.offsetCents, sp.netCents, sp.netCents > 0 ? b.walletId : null, txn, b.idempotencyKey, p.userId]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "commission.payout", entityType: "commission_payout", entityId: x!.id, requestId: c.get("requestId"), metadata: { gross, offset: sp.offsetCents, net: sp.netCents } });
      return { id: x!.id, grossCents: gross, advanceOffsetCents: sp.offsetCents, netCents: sp.netCents, replayed: false };
    });
    return c.json(out, out.replayed ? 200 : 201);
  });

  // ================= Agenda avançada =================
  const busyOf = async (q: Q, boxId: string | null, memberId: string | null, from: string, to: string, excludeApp?: string) => {
    const ap = await q.many<{ id: string; title: string; s: Date; e: Date; box_id: string | null; membership_id: string | null }>(
      `select id, title, starts_at s, ends_at e, box_id, membership_id from appointments where status = 'scheduled' and starts_at < $2 and ends_at > $1 and (($3::uuid is not null and box_id = $3) or ($4::uuid is not null and membership_id = $4)) and ($5::uuid is null or id <> $5)`, [from, to, boxId, memberId, excludeApp ?? null]);
    const tk = boxId ? await q.many<{ id: string; title: string; s: Date; e: Date }>("select id, title, planned_start s, planned_end e from production_tasks where box_id = $3 and status in ('todo','in_progress','paused') and planned_start < $2 and planned_end > $1", [from, to, boxId]) : [];
    return [...ap.map((a) => ({ kind: "appointment" as const, id: a.id, title: a.title, startsAt: a.s, endsAt: a.e })), ...tk.map((t) => ({ kind: "task" as const, id: t.id, title: t.title, startsAt: t.s, endsAt: t.e }))];
  };
  r.get("/agenda/conflicts", AG_R, async (c) => {
    const p = c.get("tenant"); const b = z.object({ startsAt: ts, endsAt: ts, boxId: uuid.optional(), membershipId: uuid.optional() }).parse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (new Date(b.endsAt) <= new Date(b.startsAt)) throw new HttpError(422, "invalid_range");
    const conflicts = await tx(p, (q) => busyOf(q, b.boxId ?? null, b.membershipId ?? null, b.startsAt, b.endsAt));
    return c.json({ conflict: conflicts.length > 0, conflicts });
  });
  r.get("/agenda/free-slot", AG_R, async (c) => {
    const p = c.get("tenant"); const b = z.object({ boxId: uuid, from: ts, to: ts, durationMinutes: z.coerce.number().int().min(15).max(1440) }).parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const busy = await tx(p, (q) => busyOf(q, b.boxId, null, b.from, b.to));
    const s = findFreeSlot(busy.map((x) => ({ startMs: new Date(x.startsAt).getTime(), endMs: new Date(x.endsAt).getTime() })), { startMs: new Date(b.from).getTime(), endMs: new Date(b.to).getTime() }, b.durationMinutes);
    return c.json({ startsAt: s === null ? null : new Date(s).toISOString() });
  });
  r.post("/agenda/waitlist", AG_W, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, z.object({ unitId: uuid.optional(), customerId: uuid, vehicleId: uuid.optional(), title: z.string().trim().min(2).max(120), durationMinutes: z.number().int().min(15).max(1440), windowFrom: ts, windowTo: ts, priority: z.number().int().min(0).max(9).default(0), note: z.string().trim().max(200).optional() }));
    if (new Date(b.windowTo) <= new Date(b.windowFrom)) throw new HttpError(422, "invalid_window");
    return c.json(await tx(p, async (q) => {
      const unit = await defaultUnit(q, b.unitId);
      if (!(await q.one("select 1 from customers where id = $1", [b.customerId]))) throw notFound("customer_not_found");
      const x = await q.one<{ id: string }>("insert into agenda_waitlist (tenant_id, unit_id, customer_id, vehicle_id, title, duration_minutes, window_from, window_to, priority, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id", [p.tenantId, unit, b.customerId, b.vehicleId ?? null, b.title, b.durationMinutes, b.windowFrom, b.windowTo, b.priority, b.note ?? null, p.userId]);
      return { id: x!.id };
    }), 201);
  });
  r.get("/agenda/waitlist", AG_R, async (c) => c.json({ entries: await tx(c.get("tenant"), (q) => q.many("select id, unit_id, customer_id, vehicle_id, title, duration_minutes, window_from, window_to, priority, status, appointment_id from agenda_waitlist where status = $1 order by priority desc, created_at", [z.enum(["waiting", "scheduled", "cancelled"]).default("waiting").parse(c.req.query("status") ?? undefined)])) }));
  r.post("/agenda/waitlist/:id/cancel", AG_W, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    await tx(p, async (q) => { if (!(await q.one("update agenda_waitlist set status = 'cancelled' where id = $1 and status = 'waiting' returning id", [id]))) throw conflict("not_waiting"); });
    return c.json({ ok: true });
  });
  /** Entradas da fila que cabem em um horário liberado (ex.: após cancelamento), por prioridade e antiguidade. */
  r.get("/agenda/waitlist/matches", AG_R, async (c) => {
    const p = c.get("tenant"); const b = z.object({ startsAt: ts, endsAt: ts, unitId: uuid.optional() }).parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const slot = { startMs: new Date(b.startsAt).getTime(), endMs: new Date(b.endsAt).getTime() };
    const rows = await tx(p, (q) => q.many<any>("select id, unit_id, customer_id, title, duration_minutes, window_from, window_to, priority from agenda_waitlist where status = 'waiting' and ($1::uuid is null or unit_id = $1) order by priority desc, created_at", [b.unitId ?? null]));
    return c.json({ matches: rows.filter((e) => waitlistFits({ windowFromMs: new Date(e.window_from).getTime(), windowToMs: new Date(e.window_to).getTime(), durationMin: e.duration_minutes }, slot)) });
  });
  r.post("/agenda/waitlist/:id/schedule", AG_W, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id")); const b = await parseJson(c, z.object({ boxId: uuid.optional(), membershipId: uuid.optional(), startsAt: ts }));
    return c.json(await tx(p, async (q) => {
      const e = await q.one<any>("select * from agenda_waitlist where id = $1 for update", [id]); if (!e) throw notFound("waitlist_not_found"); if (e.status !== "waiting") throw conflict("not_waiting");
      const start = new Date(b.startsAt); const end = new Date(start.getTime() + e.duration_minutes * 60_000);
      if (start < new Date(e.window_from) || end > new Date(e.window_to)) throw new HttpError(422, "outside_window");
      const conflicts = await busyOf(q, b.boxId ?? null, b.membershipId ?? null, start.toISOString(), end.toISOString());
      if (conflicts.length) throw conflict("slot_conflict");
      try {
        const a = await q.one<{ id: string }>("insert into appointments (tenant_id, unit_id, title, starts_at, ends_at, box_id, membership_id, customer_id, vehicle_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id", [p.tenantId, e.unit_id, e.title, start, end, b.boxId ?? null, b.membershipId ?? null, e.customer_id, e.vehicle_id, p.userId]);
        await q.query("update agenda_waitlist set status = 'scheduled', appointment_id = $2 where id = $1", [id, a!.id]);
        await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "agenda.waitlist.schedule", entityType: "appointment", entityId: a!.id, requestId: c.get("requestId") });
        return { appointmentId: a!.id, startsAt: start.toISOString(), endsAt: end.toISOString() };
      } catch (err) { if ((err as { code?: string }).code === "23P01") throw conflict("slot_conflict"); throw err; }
    }), 201);
  });

  // ================= Automações =================
  const validateCfg = (action: "whatsapp_template" | "internal_note", cfg: unknown) => {
    const parsed = action === "internal_note" ? NoteCfg.parse(cfg) : WaCfg.parse(cfg);
    const texts = action === "internal_note" ? [(parsed as z.infer<typeof NoteCfg>).text] : (parsed as z.infer<typeof WaCfg>).params;
    try { for (const t of texts) renderParam(t, {}); } catch (e) { throw new HttpError(422, "variable_not_allowed", (e as Error).message); }
    return parsed;
  };
  r.get("/automation/rules", AUTO, async (c) => c.json({ allowedVariables: AUTOMATION_VARS, rules: await tx(c.get("tenant"), (q) => q.many("select id, name, trigger_kind, action, config, enabled, version, activated_at from automation_rules order by created_at")) }));
  r.post("/automation/rules", AUTO, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, z.object({ name: z.string().trim().min(2).max(80), triggerKind: z.string().regex(/^[a-z0-9_.]{3,40}$/).refine((k) => !k.startsWith("automation."), "evento de automação não dispara automação"), action: z.enum(["whatsapp_template", "internal_note"]), config: z.unknown() }));
    const cfg = validateCfg(b.action, b.config);
    return c.json(await tx(p, async (q) => {
      try {
        const x = await q.one<{ id: string }>("insert into automation_rules (tenant_id, name, trigger_kind, action, config, created_by) values ($1,$2,$3,$4,$5,$6) returning id", [p.tenantId, b.name, b.triggerKind, b.action, JSON.stringify(cfg), p.userId]);
        await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "automation.rule.create", entityType: "automation_rule", entityId: x!.id, requestId: c.get("requestId") });
        return { id: x!.id, enabled: false };
      } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("rule_name_exists"); throw e; }
    }), 201);
  });
  r.patch("/automation/rules/:id", AUTO, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id")); const b = await parseJson(c, z.object({ name: z.string().trim().min(2).max(80).optional(), config: z.unknown().optional(), enabled: z.boolean().optional() }));
    return c.json(await tx(p, async (q) => {
      const cur = await q.one<{ action: "whatsapp_template" | "internal_note"; enabled: boolean }>("select action, enabled from automation_rules where id = $1 for update", [id]); if (!cur) throw notFound("rule_not_found");
      const cfg = b.config !== undefined ? validateCfg(cur.action, b.config) : null;
      // Reativar zera o ponto de partida: eventos anteriores à ativação NÃO são processados retroativamente.
      await q.query(`update automation_rules set name = coalesce($2, name), config = coalesce($3::jsonb, config), version = version + case when $3::jsonb is null then 0 else 1 end,
          enabled = coalesce($4, enabled), activated_at = case when $4 is true and not enabled then now() else activated_at end, updated_at = now() where id = $1`, [id, b.name ?? null, cfg ? JSON.stringify(cfg) : null, b.enabled ?? null]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "automation.rule.update", entityType: "automation_rule", entityId: id, requestId: c.get("requestId"), metadata: { enabled: b.enabled, configChanged: !!cfg } });
      return { ok: true };
    }));
  });
  r.get("/automation/settings", AUTO, async (c) => {
    const p = c.get("tenant");
    return c.json(await tx(p, async (q) => ({ enabled: (await q.one<{ enabled: boolean }>("select enabled from automation_settings"))?.enabled ?? true, usedThisMonth: await usedThisMonth(q),
      monthlyLimit: p.entitlements.values["automation.monthly"] ?? 0, platformKillSwitch: (await q.one<{ on: boolean }>("select coalesce((value ->> 'on')::boolean, false) as on from platform_settings where key = $1", [KILL_KEY]))?.on ?? false })));
  });
  r.put("/automation/settings", AUTO, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, z.object({ enabled: z.boolean() }));
    await tx(p, async (q) => {
      await q.query("insert into automation_settings (tenant_id, enabled, updated_by) values ($1,$2,$3) on conflict (tenant_id) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()", [p.tenantId, b.enabled, p.userId]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "automation.settings", entityType: "tenant", entityId: p.tenantId, requestId: c.get("requestId"), metadata: { enabled: b.enabled } });
    });
    return c.json({ enabled: b.enabled });
  });
  r.get("/automation/runs", AUTO, async (c) => c.json({ runs: await tx(c.get("tenant"), (q) => q.many("select id, rule_id, rule_version, source_key, status, detail, created_at from automation_runs order by id desc limit 200")) }));
  r.post("/automation/run", AUTO, async (c) => c.json(await runAutomations(deps, { tenantId: c.get("tenant").tenantId })));
  void checkLimit;

  // Kill-switch global (Super Admin): para TODAS as execuções, sem apagar regras.
  r.get("/platform/automation/kill-switch", PLAT, async (c) => c.json(await plat(async (q) => ({ on: (await q.one<{ on: boolean }>("select coalesce((value ->> 'on')::boolean, false) as on from platform_settings where key = $1", [KILL_KEY]))?.on ?? false }))));
  r.put("/platform/automation/kill-switch", PLAT, async (c) => {
    const b = await parseJson(c, z.object({ on: z.boolean(), reason: z.string().trim().min(3).max(200) })); const pu = c.get("platform");
    await plat(async (q) => {
      await q.query("insert into platform_settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value", [KILL_KEY, JSON.stringify({ on: b.on })]);
      await audit(q, { tenantId: null, actorType: "platform_user", actorId: pu.platformUserId, action: "automation.kill_switch", entityType: "platform", entityId: KILL_KEY, requestId: c.get("requestId"), metadata: { on: b.on, reason: b.reason } });
    });
    return c.json({ on: b.on });
  });
  r.post("/platform/automation/run", PLAT, async (c) => c.json(await runAutomations(deps)));
}
