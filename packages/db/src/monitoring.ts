import type { AppConfig } from '@memebots/config';
import { createHash } from 'node:crypto';

import { recordAudit } from './audit.js';
import type { Pool, Queryable } from './pool.js';
import { withTransaction } from './pool.js';

export const HEARTBEAT_INTERVAL_MS = 10_000;
export const MONITOR_INTERVAL_MS = 5_000;
export const STALE_HEARTBEAT_MS = 40_000;
export type AlertCategory =
  'bot_stalled' | 'rpc_unhealthy' | 'discovery_unhealthy' | 'kill_switch' | 'losing_streak';
export type AlertCode =
  | 'heartbeat_stale'
  | 'http'
  | 'rpc'
  | 'malformed'
  | 'timeout'
  | 'transport'
  | 'unavailable'
  | 'engaged'
  | 'sell_all'
  | 'streak_limit';
export interface BotLease {
  readonly botId: string;
  readonly ownerId: string;
  readonly generation: string;
}
export interface AlertEvent {
  readonly id: string;
  readonly incidentId: string;
  readonly category: AlertCategory;
  readonly entityId: string;
  readonly transition: 'opened' | 'resolved';
  readonly code: AlertCode;
}

/** Acquire all persisted paper bots atomically. A second healthy engine cannot steal them. */
export async function acquireBotLeases(pool: Pool, ownerId: string): Promise<BotLease[]> {
  return withTransaction(pool, async (db) => {
    const bots = await db.query<{ bot_id: string; available: boolean }>(`
      SELECT h.bot_id, (h.owner_id IS NULL OR NOT h.expected OR
        COALESCE(h.heartbeat_at, h.expected_since) <= clock_timestamp() - interval '40 seconds') AS available
      FROM bot_heartbeats h JOIN bots b ON b.id = h.bot_id WHERE b.mode = 'paper'
      ORDER BY h.bot_id FOR UPDATE OF h`);
    if (bots.rows.some((bot) => !bot.available)) throw new Error('BOT_LEASE_ALREADY_OWNED');
    const leases: BotLease[] = [];
    for (const bot of bots.rows) {
      const result = await db.query<{ generation: string }>(
        `
        UPDATE bot_heartbeats SET owner_id = $2, generation = generation + 1, expected = true,
          expected_since = clock_timestamp(), heartbeat_at = NULL, progress_kind = 'scaffold'
        WHERE bot_id = $1 RETURNING generation`,
        [bot.bot_id, ownerId],
      );
      leases.push({ botId: bot.bot_id, ownerId, generation: result.rows[0]!.generation });
    }
    return leases;
  });
}

/** Call only after the managed bot's awaited tick completes. Generations fence crashed owners. */
export async function publishBotProgress(
  db: Queryable,
  lease: BotLease,
  kind: 'scaffold' | 'strategy',
): Promise<void> {
  const result = await db.query(
    `UPDATE bot_heartbeats h SET heartbeat_at = clock_timestamp(), progress_kind = $4
    FROM bots b WHERE h.bot_id = b.id AND h.bot_id = $1 AND owner_id = $2 AND generation = $3
    AND h.expected AND b.mode = 'paper'`,
    [lease.botId, lease.ownerId, lease.generation, kind],
  );
  if (result.rowCount !== 1) throw new Error('BOT_LEASE_LOST');
}

export async function releaseBotLeases(db: Queryable, ownerId: string): Promise<void> {
  await db.query(
    `UPDATE bot_heartbeats SET expected = false, owner_id = NULL, generation = generation + 1
    WHERE owner_id = $1`,
    [ownerId],
  );
}
export async function scanBotHealth(db: Queryable): Promise<void> {
  await db.query('SELECT monitoring_scan()');
}
export async function observeHealth(
  db: Queryable,
  category: AlertCategory,
  entity: 'solana' | 'discovery',
  failed: boolean,
  code: AlertCode,
): Promise<void> {
  await db.query('SELECT monitoring_transition($1, $2, $3, $4)', [category, entity, failed, code]);
}

/** At least once: a crash after emission but before receipt can repeat the same event ID. */
export async function deliverAlerts(
  db: Queryable,
  sink: (event: AlertEvent) => void,
): Promise<void> {
  const result = await db.query<AlertEvent>(`SELECT e.id::text AS id, e.incident_id AS "incidentId",
    i.category, i.entity_id AS "entityId", e.transition, e.code
    FROM monitoring_events e JOIN monitoring_incidents i ON i.id = e.incident_id
    LEFT JOIN monitoring_deliveries d ON d.event_id = e.id
    WHERE d.event_id IS NULL ORDER BY e.id LIMIT 100`);
  await emitAndReceipt(db, result.rows, sink);
}

async function emitAndReceipt(
  db: Queryable,
  events: AlertEvent[],
  sink: (event: AlertEvent) => void,
): Promise<void> {
  for (const event of events) sink(event);
  if (events.length)
    await db.query(
      'INSERT INTO monitoring_deliveries(event_id) SELECT unnest($1::bigint[]) ON CONFLICT DO NOTHING',
      [events.map((event) => event.id)],
    );
}

/** Watchdog uses one bounded DB statement for detection + outbox read, then emits synchronously. */
export async function pollBotAlerts(
  db: Queryable,
  sink: (event: AlertEvent) => void,
): Promise<void> {
  const result = await db.query<AlertEvent>('SELECT * FROM monitoring_poll()');
  await emitAndReceipt(db, result.rows, sink);
}

export async function monitoringHealth(db: Queryable) {
  const incidents =
    await db.query(`SELECT id, category, entity_id, first_observed_at, last_observed_at, code
    FROM monitoring_incidents WHERE resolved_at IS NULL ORDER BY first_observed_at LIMIT 100`);
  const bots =
    await db.query(`SELECT h.bot_id, h.expected, h.heartbeat_at, h.expected_since, h.progress_kind,
    CASE WHEN b.mode <> 'paper' OR NOT h.expected THEN 'disabled'
      WHEN COALESCE(h.heartbeat_at,h.expected_since) <= clock_timestamp() - interval '40 seconds' THEN 'stalled'
      WHEN h.heartbeat_at IS NULL THEN 'starting' ELSE 'healthy' END AS status
    FROM bot_heartbeats h JOIN bots b ON b.id = h.bot_id ORDER BY h.bot_id LIMIT 100`);
  const services = await db.query(`SELECT category, entity_id, observed_at, code,
    CASE WHEN observed_at < clock_timestamp() - interval '30 seconds' THEN 'unknown_stale' ELSE status END AS status
    FROM monitoring_health ORDER BY category, entity_id`);
  return { incidents: incidents.rows, bots: bots.rows, services: services.rows };
}

/** The shape is built here, never from serializing config/Secret objects or endpoint values. */
export async function auditStartup(
  pool: Pool,
  service: 'engine' | 'monitor',
  config: AppConfig,
): Promise<void> {
  const policy = {
    mode: config.mode,
    marketData: config.marketData,
    discoveryEnabled: config.discovery.enabled,
    apiPort: config.api.port,
    monthlyServiceBudgetUsd: config.limits.monthlyServiceBudgetUsd,
    heliusMonthlyCreditStop: config.limits.heliusMonthlyCreditStop,
    jupiterRequestsPerMinute: config.limits.jupiterRequestsPerMinute,
    watchlistSize: config.limits.watchlistSize,
    snapshotIntervalMs: config.limits.snapshotIntervalMs,
    maxDataAgeMs: config.limits.maxDataAgeMs,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  await withTransaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 12))', [
      `startup:${service}`,
    ]);
    const previous = await db.query<{ fingerprint: string; policy: unknown }>(
      'SELECT fingerprint, policy FROM runtime_config_snapshots WHERE service = $1',
      [service],
    );
    const prior = previous.rows[0];
    if (prior && prior.fingerprint !== fingerprint)
      await recordAudit(db, {
        actor: 'system',
        action: 'config.changed',
        entityType: 'runtime',
        entityId: service,
        details: { beforeFingerprint: prior.fingerprint, after: policy, fingerprint },
      });
    await db.query(
      `INSERT INTO runtime_config_snapshots(service, fingerprint, policy) VALUES ($1,$2,$3)
      ON CONFLICT(service) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, policy = EXCLUDED.policy, updated_at = clock_timestamp()`,
      [service, fingerprint, JSON.stringify(policy)],
    );
    await recordAudit(db, {
      actor: 'system',
      action: 'runtime.boot',
      entityType: 'runtime',
      entityId: service,
      details: { policy, fingerprint },
    });
  });
}
