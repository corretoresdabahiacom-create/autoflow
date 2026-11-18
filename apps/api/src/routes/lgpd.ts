import { z } from "zod";
import { audit } from "../audit";
import type { Q } from "../db";
import { HttpError, conflict, notFound, parseJson } from "../http";
import type { Router } from "../router";
import type { Deps } from "../types";
import { tctx } from "./tenant";

const uuid = z.string().uuid();
const POL = { auth: "tenant", permission: "lgpd:manage" } as const;

/** Direitos do titular (LGPD art. 18): exportação (acesso/portabilidade) e anonimização (eliminação), com evidência sem PII. */
export function registerLgpdRoutes(r: Router, deps: Deps): void {
  const tx = <T>(p: Parameters<typeof tctx>[0], fn: (q: Q) => Promise<T>) => deps.db.tx(tctx(p), fn);

  r.get("/customers/:id/export", POL, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const out = await tx(p, async (q) => {
      const cu = await q.one<Record<string, unknown>>("select to_jsonb(c) - 'tenant_id' as j from customers c where id = $1", [id]);
      if (!cu) throw notFound("customer_not_found");
      const j = (sql: string, a: unknown[]) => q.many<{ j: unknown }>(sql, a).then((rows) => rows.map((x) => x.j));
      const c0 = (cu as { j: { phone_e164: string | null; email: string | null } }).j;
      const data = {
        customer: (cu as { j: unknown }).j,
        vehicles: await j("select to_jsonb(v) - 'tenant_id' j from vehicles v where customer_id = $1", [id]),
        orders: await j("select to_jsonb(o) - 'tenant_id' j from service_orders o where customer_id = $1 order by number", [id]),
        financialDocuments: await j("select to_jsonb(d) - 'tenant_id' j from fin_documents d where customer_id = $1 order by competence_date", [id]),
        marketingConsentHistory: await j("select to_jsonb(m) - 'tenant_id' j from marketing_consent_log m where customer_id = $1 order by id", [id]),
        whatsappMessages: await j("select to_jsonb(w) - 'tenant_id' j from wa_messages w where customer_id = $1 order by created_at", [id]),
        leads: await j("select to_jsonb(l) - 'tenant_id' - 'ip_hash' j from leads l where ($1::text is not null and phone_e164 = $1) or ($2::text is not null and lower(email) = lower($2))", [c0.phone_e164, c0.email]),
      };
      await q.query("insert into lgpd_requests (tenant_id, customer_id, kind, details, requested_by) values ($1,$2,'export',$3,$4)", [p.tenantId, id, JSON.stringify({ vehicles: data.vehicles.length, orders: data.orders.length, documents: data.financialDocuments.length }), p.userId]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "lgpd.export", entityType: "customer", entityId: id, requestId: c.get("requestId") }); // sem o conteúdo exportado
      return { generatedAt: new Date().toISOString(), basis: "LGPD art. 18 (acesso/portabilidade)", ...data };
    });
    c.header("Content-Disposition", `attachment; filename="titular-${id}.json"`);
    return c.json(out);
  });

  /**
   * Anonimização (eliminação do que a lei não manda guardar). Mantém, por obrigação legal/regular exercício de direitos
   * (docs/LEGAL_RETENTION.md): OS, documentos financeiros/ledger, evidências de aprovação e o histórico de consentimento.
   * Bloqueia enquanto houver obrigação em aberto (OS aberta ou parcela a receber/pagar em aberto).
   */
  r.post("/customers/:id/anonymize", POL, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ reason: z.string().trim().min(3).max(300), confirm: z.literal("ANONIMIZAR") }));
    const out = await tx(p, async (q) => {
      const cu = await q.one<{ phone_e164: string | null; email: string | null; anonymized_at: Date | null }>("select phone_e164, email, anonymized_at from customers where id = $1 for update", [id]);
      if (!cu) throw notFound("customer_not_found"); if (cu.anonymized_at) throw conflict("already_anonymized");
      if (await q.one("select 1 from service_orders where customer_id = $1 and status = 'open' limit 1", [id])) throw conflict("has_open_obligations");
      if (await q.one(`select 1 from fin_documents d where d.customer_id = $1 and d.cancelled_at is null and exists (
          select 1 from fin_installments i where i.doc_id = d.id and i.amount_cents > coalesce((select sum(a.principal_cents) from fin_allocations a join fin_settlements st on st.tenant_id = a.tenant_id and st.id = a.settlement_id where a.installment_id = i.id and st.reversed_at is null), 0)) limit 1`, [id])) throw conflict("has_open_obligations");
      const counts: Record<string, number> = {};
      counts.waCancelled = (await q.query("update wa_messages set status = 'failed', error = 'titular_anonimizado' where customer_id = $1 and status = 'queued'", [id])).rowCount ?? 0;
      counts.remindersCancelled = (await q.query("update service_reminders set status = 'cancelled' where customer_id = $1 and status in ('pending','queued')", [id])).rowCount ?? 0;
      counts.portalLinksRevoked = (await q.query("update portal_links set revoked_at = now() where revoked_at is null and os_id in (select id from service_orders where customer_id = $1)", [id])).rowCount ?? 0;
      counts.waPhonesErased = (await q.query("update wa_messages set to_phone = null where customer_id = $1 and to_phone is not null", [id])).rowCount ?? 0;
      counts.leadsAnonymized = (await q.query(`update leads set name = 'Titular anonimizado', phone_e164 = '+00000000000', email = null, vehicle = null, plate = null, description = null, ip_hash = null
         where ($1::text is not null and phone_e164 = $1) or ($2::text is not null and lower(email) = lower($2))`, [cu.phone_e164, cu.email])).rowCount ?? 0;
      await q.query("update customers set name = 'Titular anonimizado', phone_e164 = null, email = null, origin = null, marketing_opt_in = false, anonymized_at = now() where id = $1", [id]); // opt-in revogado (trigger registra no histórico)
      await q.query("insert into lgpd_requests (tenant_id, customer_id, kind, reason, details, requested_by) values ($1,$2,'anonymize',$3,$4,$5)", [p.tenantId, id, b.reason, JSON.stringify(counts), p.userId]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "lgpd.anonymize", entityType: "customer", entityId: id, requestId: c.get("requestId"), metadata: counts });
      return { anonymized: true, ...counts, retained: ["service_orders", "fin_documents/ledger", "approval_evidence", "marketing_consent_log"], note: "Registros mantidos por obrigação legal/exercício regular de direitos; ver LEGAL_RETENTION." };
    });
    return c.json(out);
  });
  void HttpError;
}
