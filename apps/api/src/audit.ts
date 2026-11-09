import type { Q } from "./db";

export interface AuditEntry {
  tenantId?: string | null;
  actorType: "user" | "platform_user" | "system";
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  requestId?: string;
  ipHash?: string;
  /** Nunca colocar PII sensível (senha, token, documento) aqui. */
  metadata?: Record<string, unknown>;
}

export async function audit(q: Q, e: AuditEntry): Promise<void> {
  await q.query(
    `insert into audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, request_id, ip_hash, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      e.tenantId ?? null,
      e.actorType,
      e.actorId ?? null,
      e.action,
      e.entityType ?? null,
      e.entityId ?? null,
      e.requestId ?? null,
      e.ipHash ?? null,
      JSON.stringify(e.metadata ?? {}),
    ],
  );
}
