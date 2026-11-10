import type { Q } from "./db";

export interface TimelineEvent {
  tenantId: string;
  unitId: string;
  osId: string;
  kind: string;
  title: string;
  visibleToCustomer?: boolean;
}

/** Registra evento na linha do tempo e, se visível ao cliente, enfileira notificação NA MESMA TRANSAÇÃO (outbox). */
export async function addTimeline(q: Q, e: TimelineEvent): Promise<void> {
  const visible = e.visibleToCustomer ?? true;
  await q.query(
    "insert into os_timeline (tenant_id, unit_id, os_id, kind, title, visible_to_customer) values ($1,$2,$3,$4,$5,$6)",
    [e.tenantId, e.unitId, e.osId, e.kind, e.title, visible],
  );
  if (visible) {
    await q.query(
      "insert into outbox (tenant_id, unit_id, os_id, kind, payload) values ($1,$2,$3,'portal.update',$4)",
      [e.tenantId, e.unitId, e.osId, JSON.stringify({ title: e.title, kind: e.kind })],
    );
  }
}
