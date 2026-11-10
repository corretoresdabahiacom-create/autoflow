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
        `update outbox set attempts = $2, last_error = $3, status = case when $2 >= $4 then 'failed' else 'pending' end,
           available_at = now() + make_interval(secs => 30 * power(2, $2::int)) where id = $1`,
        [row.id, attempts, (e as Error).name, MAX_ATTEMPTS]));
      res.failed++;
    }
  }
  return res;
}
