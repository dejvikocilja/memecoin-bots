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

export type VetoCategory =
  'risk_limit' | 'safety' | 'balance' | 'slippage' | 'kill_switch' | 'stale_data' | 'policy';

/** Set transaction-local attribution before business SQL; canonical events come from DB triggers. */
export async function setAuditActor(
  db: Queryable,
  actor: 'owner' | 'system' | `bot:${string}`,
): Promise<void> {
  if (actor !== 'owner' && actor !== 'system' && !/^bot:[a-f0-9-]{36}$/.test(actor))
    throw new Error('INVALID_AUDIT_ACTOR');
  await db.query("SELECT set_config('memebots.actor', $1, true)", [actor]);
}

/** Complementary intent event for future risk decisions before an order exists. No free text. */
export async function recordRiskVeto(
  db: Queryable,
  botId: string,
  category: VetoCategory,
): Promise<void> {
  if (
    !/^[a-f0-9-]{36}$/.test(botId) ||
    ![
      'risk_limit',
      'safety',
      'balance',
      'slippage',
      'kill_switch',
      'stale_data',
      'policy',
    ].includes(category)
  )
    throw new Error('INVALID_AUDIT_EVENT');
  await recordAudit(db, {
    actor: `bot:${botId}`,
    action: 'risk.vetoed',
    entityType: 'bot',
    entityId: botId,
    details: { reasonCategory: category },
  });
}
