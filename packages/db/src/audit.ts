import type { Queryable } from './pool.js';

export interface AuditEntry {
  /** Who did it: "owner", "system", or "bot:<id>". */
  readonly actor: string;
  /** What happened, such as "order.vetoed" or "bot.mode_changed". */
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string;
  readonly details?: Record<string, unknown>;
}

/** Appends to the audit log. The table rejects updates and deletes. */
export async function recordAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query(
    'INSERT INTO audit_log (actor, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
    [
      entry.actor,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      JSON.stringify(entry.details ?? {}),
    ],
  );
}
