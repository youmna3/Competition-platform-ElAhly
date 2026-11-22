import type { Pool, PoolConnection, Connection } from 'mysql2/promise';

export interface AuditEntry {
  actorId?: number | null;
  actorEmail?: string | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  ipAddress?: string | null;
  details?: Record<string, unknown>;
}

/** Appends one row to the audit log. Never pass passwords or secrets in details. */
export async function writeAudit(
  db: Pool | PoolConnection | Connection,
  entry: AuditEntry,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, actor_email, action, entity_type, entity_id, ip_address, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.actorId ?? null,
      entry.actorEmail ? entry.actorEmail.slice(0, 254) : null,
      entry.action,
      entry.entityType,
      entry.entityId === undefined || entry.entityId === null ? null : String(entry.entityId),
      entry.ipAddress ? entry.ipAddress.slice(0, 45) : null,
      JSON.stringify(entry.details ?? {}),
    ],
  );
}
