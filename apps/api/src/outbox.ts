import { decryptSecret } from "./crypto";
import { optOutPath } from "./optout";
import type { Deps } from "./types";

const MAX_ATTEMPTS = 5;

/** Processa pendências do outbox de UM tenant. Consentimento verificado por envio; falha => backoff; sem consentimento => skipped. */
export async function processOutbox(deps: Deps, tenantId: string, limit = 50): Promise<{ sent: number; skipped: number; failed: number }> {
  const res = { sent: 0, skipped: 0, failed: 0 };
  const ctx = { actor: "tenant", tenantId, unitScope: "all" } as const;
  const rows = await deps.db.tx(ctx, (q) =>
    q.many<{ id: string; os_id: string | null; kind: string; payload: { title?: string }; attempts: number }>(
      "select id, os_id, kind, payload, attempts from outbox where status = 'pending' and available_at <= now() order by id limit $1 for update skip locked", [limit]));
  for (const row of rows) {
    if (row.kind === "whatsapp") {
      // WhatsApp: só templates; marketing reverifica consentimento no envio; sem conexão => skipped. Falha => backoff.
      const pl = row.payload as { waMessageId?: string; params?: string[]; lang?: string };
      const m = await deps.db.tx(ctx, (q) => q.one<{ id: string; template: string; category: string; to_phone: string; opt: boolean | null; secret_enc: string | null; config: Record<string, string> | null }>(
        `select m.id, m.template, m.category, m.to_phone, c.marketing_opt_in opt, k.secret_enc, k.config
           from wa_messages m left join customers c on c.tenant_id = m.tenant_id and c.id = m.customer_id
           left join integration_connections k on k.tenant_id = m.tenant_id and k.kind = 'whatsapp' and k.status = 'connected' where m.id = $1`, [pl.waMessageId ?? null]));
      const skip = async (why: string) => { await deps.db.tx(ctx, async (q) => { await q.query("update outbox set status = 'skipped', last_error = $2 where id = $1", [row.id, why]); if (m) await q.query("update wa_messages set status = 'failed', error = $2, updated_at = now() where id = $1", [m.id, why]); }); res.skipped++; };
      if (!m) { await skip("message_not_found"); continue; }
      if (!m.secret_enc || !m.config?.phone_number_id) { await skip("not_connected"); continue; }
      if (m.category === "marketing" && !m.opt) { await skip("opted_out"); continue; }
      try {
        const token = await decryptSecret(m.secret_enc, deps.config.encryptionKey);
        const r = await deps.whatsapp.sendTemplate({ phoneNumberId: m.config.phone_number_id, token }, { to: m.to_phone, template: m.template, lang: pl.lang ?? "pt_BR", params: pl.params ?? [] });
        await deps.db.tx(ctx, async (q) => { await q.query("update wa_messages set status = 'sent', provider_message_id = $2, updated_at = now() where id = $1", [m.id, r.providerMessageId]); await q.query("update outbox set status = 'sent', attempts = attempts + 1 where id = $1", [row.id]); }); res.sent++;
      } catch (e) {
        const attempts = row.attempts + 1;
        await deps.db.tx(ctx, async (q) => {
          await q.query(`update outbox set attempts = $2::int, last_error = $3, status = case when $2::int >= $4::int then 'failed' else 'pending' end, available_at = now() + make_interval(secs => 30 * power(2, $2::int)) where id = $1`, [row.id, attempts, (e as Error).name, MAX_ATTEMPTS]);
          if (attempts >= MAX_ATTEMPTS) await q.query("update wa_messages set status = 'failed', error = 'provider_error', updated_at = now() where id = $1", [m.id]);
        });
        res.failed++;
      }
      continue;
    }
    if (row.kind === "campaign") {
      // Marketing: consentimento e opt-out reverificados NO ENVIO (opt-out é imediato mesmo com a campanha já enfileirada).
      const cid = String((row.payload as { customerId?: string }).customerId ?? "");
      const cu = await deps.db.tx(ctx, (q) => q.one<{ email: string | null; opt: boolean }>("select email::text email, marketing_opt_in opt from customers where id = $1", [cid]));
      if (!cu || !cu.opt || !cu.email) {
        await deps.db.tx(ctx, (q) => q.query("update outbox set status = 'skipped', last_error = $2 where id = $1", [row.id, !cu?.opt ? "opted_out" : "no_email"])); res.skipped++; continue;
      }
      try {
        const link = `${deps.config.publicBaseUrl}${await optOutPath(deps.config.encryptionKey, tenantId, cid)}`;
        await deps.email.send({ to: cu.email, template: "notification", vars: { title: String(row.payload.title ?? "Novidades da oficina"), optOutUrl: link } });
        await deps.db.tx(ctx, (q) => q.query("update outbox set status = 'sent', attempts = attempts + 1 where id = $1", [row.id])); res.sent++;
      } catch (e) {
        const attempts = row.attempts + 1;
        await deps.db.tx(ctx, (q) => q.query(`update outbox set attempts = $2::int, last_error = $3, status = case when $2::int >= $4::int then 'failed' else 'pending' end, available_at = now() + make_interval(secs => 30 * power(2, $2::int)) where id = $1`, [row.id, attempts, (e as Error).name, MAX_ATTEMPTS]));
        res.failed++;
      }
      continue;
    }
    if (row.kind === "lead.new") {
      // Notificação interna para a equipe (não depende de consentimento do cliente).
      const staff = await deps.db.tx(ctx, (q) => q.many<{ email: string }>(
        `select distinct u.email from memberships m join users u on u.id = m.user_id join roles r on r.id = m.role_id
          where m.status = 'active' and r.key in ('owner','admin','manager','attendant') limit 10`));
      try {
        for (const s of staff) await deps.email.send({ to: s.email, template: "notification", vars: { title: String(row.payload.title ?? "Novo lead") } });
        await deps.db.tx(ctx, (q) => q.query("update outbox set status = 'sent', attempts = attempts + 1 where id = $1", [row.id])); res.sent++;
      } catch (e) {
        const attempts = row.attempts + 1;
        await deps.db.tx(ctx, (q) => q.query(`update outbox set attempts = $2::int, last_error = $3, status = case when $2::int >= $4::int then 'failed' else 'pending' end, available_at = now() + make_interval(secs => 30 * power(2, $2::int)) where id = $1`, [row.id, attempts, (e as Error).name, MAX_ATTEMPTS]));
        res.failed++;
      }
      continue;
    }
    const dest = row.os_id
      ? await deps.db.tx(ctx, (q) => q.one<{ customer_id: string; email: string | null }>(
          "select c.id as customer_id, c.email from service_orders o join customers c on c.tenant_id = o.tenant_id and c.id = o.customer_id where o.id = $1", [row.os_id]))
      : null;
    const consent = dest
      ? await deps.db.tx(ctx, (q) => q.one("select 1 as ok from consents where subject_ref = $1 and purpose = 'order_notifications' and channel = 'email' and revoked_at is null", [`customer:${dest.customer_id}`]))
      : null;
    if (!dest?.email || !consent) {
      await deps.db.tx(ctx, (q) => q.query("update outbox set status = 'skipped', last_error = $2 where id = $1", [row.id, !dest?.email ? "no_email" : "no_consent"]));
      res.skipped++; continue;
    }
    try {
      await deps.email.send({ to: dest.email, template: "notification", vars: { title: String(row.payload.title ?? "Atualização da sua OS") } });
      await deps.db.tx(ctx, (q) => q.query("update outbox set status = 'sent', attempts = attempts + 1 where id = $1", [row.id]));
      res.sent++;
    } catch (e) {
      const attempts = row.attempts + 1;
      await deps.db.tx(ctx, (q) => q.query(
        `update outbox set attempts = $2::int, last_error = $3, status = case when $2::int >= $4::int then 'failed' else 'pending' end,
           available_at = now() + make_interval(secs => 30 * power(2, $2::int)) where id = $1`,
        [row.id, attempts, (e as Error).name, MAX_ATTEMPTS]));
      res.failed++;
    }
  }
  return res;
}
