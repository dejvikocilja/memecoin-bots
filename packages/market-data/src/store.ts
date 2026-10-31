import pg from 'pg';
import type { PoolClient } from 'pg';

import type { TokenOutcome } from './types.js';

export type StorageOutcome =
  | TokenOutcome
  | {
      readonly status: 'unavailable';
      readonly tokenAddress: string;
      readonly reason: 'deadline_exceeded' | 'quota_exhausted' | 'collection_gap';
    };

export interface StoredCycle {
  readonly id: string;
  readonly scheduledAt: number;
  readonly completedAt: number;
  /** Start of an unobserved interval after restart/overrun; never filled in. */
  readonly gapFrom?: number;
  readonly outcomes: readonly StorageOutcome[];
}

export interface HistoryEntry {
  readonly cycleId: string;
  readonly scheduledAt: number;
  readonly completedAt: number;
  readonly gapFrom?: number;
  readonly outcome: StorageOutcome;
}

export interface HistoryQuery {
  readonly tokenAddress: string;
  /** Inclusive milliseconds since the Unix epoch. */
  readonly from: number;
  /** Exclusive milliseconds since the Unix epoch. */
  readonly to: number;
  readonly limit?: number;
}

export interface SnapshotStore {
  latestScheduledAt(): Promise<number | null>;
  /** Persist before HTTP so a process crash cannot reset the request quota. */
  recordRequest(startedAt: number): Promise<void>;
  /** Includes future timestamps conservatively after a backwards clock jump. */
  getRecentRequestTimes(since: number): Promise<number[]>;
  /** Retry-After survives process restarts and can only extend the pause. */
  deferRequests(until: number): Promise<void>;
  requestsNotBefore(): Promise<number | null>;
  /** Atomic append of every outcome and the checkpoint; false means an identical replay. */
  commitCycle(cycle: StoredCycle): Promise<boolean>;
  readTokenHistory(query: HistoryQuery): Promise<readonly HistoryEntry[]>;
  close(): Promise<void>;
}

export class StoreError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'connection_failed'
      | 'collector_already_running'
      | 'query_failed'
      | 'cycle_conflict'
      | 'closed',
  ) {
    super(`Market data storage: ${code}`);
    this.name = 'StoreError';
  }
}

// This migration owns only BOT-7 tables. It does not modify BOT-5's domain schema.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS market_feed_schema (
  version integer PRIMARY KEY CHECK (version = 1)
);
CREATE TABLE IF NOT EXISTS market_feed_cycles (
  stream_id text NOT NULL,
  cycle_id text NOT NULL,
  scheduled_at bigint NOT NULL CHECK (scheduled_at >= 0),
  completed_at bigint NOT NULL CHECK (completed_at >= scheduled_at),
  gap_from bigint CHECK (gap_from >= 0 AND gap_from <= scheduled_at),
  outcome_count integer NOT NULL CHECK (outcome_count > 0 AND outcome_count <= 10000),
  PRIMARY KEY (stream_id, cycle_id),
  UNIQUE (stream_id, scheduled_at)
);
CREATE TABLE IF NOT EXISTS market_feed_records (
  stream_id text NOT NULL,
  cycle_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  token_address text NOT NULL,
  outcome jsonb NOT NULL CHECK (
    jsonb_typeof(outcome) = 'object'
    AND outcome ? 'status' AND outcome ? 'tokenAddress'
    AND outcome->>'status' IN ('ok', 'unavailable')
    AND outcome->>'tokenAddress' = token_address
  ),
  PRIMARY KEY (stream_id, cycle_id, ordinal),
  UNIQUE (stream_id, cycle_id, token_address),
  FOREIGN KEY (stream_id, cycle_id) REFERENCES market_feed_cycles(stream_id, cycle_id)
);
CREATE INDEX IF NOT EXISTS market_feed_history_idx
  ON market_feed_records(stream_id, token_address, cycle_id);
CREATE TABLE IF NOT EXISTS market_feed_requests (
  stream_id text NOT NULL,
  request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at bigint NOT NULL CHECK (started_at >= 0)
);
CREATE INDEX IF NOT EXISTS market_feed_requests_time_idx
  ON market_feed_requests(stream_id, started_at);
CREATE TABLE IF NOT EXISTS market_feed_backoff (
  stream_id text NOT NULL,
  entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  until_ms bigint NOT NULL CHECK (until_ms >= 0)
);
CREATE INDEX IF NOT EXISTS market_feed_backoff_idx
  ON market_feed_backoff(stream_id, until_ms);
CREATE OR REPLACE FUNCTION market_feed_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Market feed history is append-only';
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'market_feed_cycles_immutable'
      AND tgrelid = 'market_feed_cycles'::regclass) THEN
    CREATE TRIGGER market_feed_cycles_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
      ON market_feed_cycles FOR EACH STATEMENT EXECUTE FUNCTION market_feed_reject_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'market_feed_records_immutable'
      AND tgrelid = 'market_feed_records'::regclass) THEN
    CREATE TRIGGER market_feed_records_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
      ON market_feed_records FOR EACH STATEMENT EXECUTE FUNCTION market_feed_reject_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'market_feed_requests_immutable'
      AND tgrelid = 'market_feed_requests'::regclass) THEN
    CREATE TRIGGER market_feed_requests_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
      ON market_feed_requests FOR EACH STATEMENT EXECUTE FUNCTION market_feed_reject_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'market_feed_backoff_immutable'
      AND tgrelid = 'market_feed_backoff'::regclass) THEN
    CREATE TRIGGER market_feed_backoff_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
      ON market_feed_backoff FOR EACH STATEMENT EXECUTE FUNCTION market_feed_reject_mutation();
  END IF;
END;
$$;
INSERT INTO market_feed_schema(version) VALUES (1) ON CONFLICT DO NOTHING;
`;

const isTimestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const isKey = (value: string): boolean => value.length > 0 && value.length <= 256;

/** Reject invalid cycles before opening a transaction or serializing data. */
export function validateCycle(cycle: StoredCycle): void {
  if (
    !isKey(cycle.id) ||
    !isTimestamp(cycle.scheduledAt) ||
    !isTimestamp(cycle.completedAt) ||
    cycle.completedAt < cycle.scheduledAt ||
    (cycle.gapFrom !== undefined &&
      (!isTimestamp(cycle.gapFrom) || cycle.gapFrom > cycle.scheduledAt)) ||
    cycle.outcomes.length === 0 ||
    cycle.outcomes.length > 10000
  ) {
    throw new StoreError('invalid_input');
  }
  const seen = new Set<string>();
  for (const outcome of cycle.outcomes) {
    if (
      !isKey(outcome.tokenAddress) ||
      seen.has(outcome.tokenAddress) ||
      (outcome.status !== 'ok' && outcome.status !== 'unavailable')
    ) {
      throw new StoreError('invalid_input');
    }
    seen.add(outcome.tokenAddress);
    if (outcome.status === 'ok') {
      const snapshot = outcome.snapshot;
      if (
        snapshot.tokenAddress !== outcome.tokenAddress ||
        !isTimestamp(snapshot.receivedAt) ||
        snapshot.receivedAt > cycle.completedAt
      ) {
        throw new StoreError('invalid_input');
      }
    }
  }
}

export interface PostgresStoreOptions {
  readonly connectionString: string;
  readonly streamId?: string;
  readonly queryTimeoutMs?: number;
}

/**
 * Holds one database session and a stream-scoped advisory lock until close().
 * A crashed process loses the lock automatically; committed history remains.
 * No provider request should run until this function succeeds.
 */
export async function openPostgresSnapshotStore({
  connectionString,
  streamId = 'dexscreener-solana',
  queryTimeoutMs = 10000,
}: PostgresStoreOptions): Promise<SnapshotStore> {
  if (
    !isKey(streamId) ||
    !Number.isSafeInteger(queryTimeoutMs) ||
    queryTimeoutMs < 100 ||
    queryTimeoutMs > 60000
  ) {
    throw new StoreError('invalid_input');
  }
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: queryTimeoutMs,
    statement_timeout: queryTimeoutMs,
    query_timeout: queryTimeoutMs + 1000,
  });
  // The same fixed message is used for connection/query errors: pg errors can
  // include connection strings or other infrastructure details.
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    await pool.end();
    throw new StoreError('connection_failed');
  }
  let closed = false;
  let closing = false;
  let failed = false;
  // Swallow the event only after marking the store unusable. A later method
  // throws a sanitized error; no raw driver error reaches a log sink.
  client.on('error', () => {
    failed = true;
  });
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(748184201)');
    await client.query(SCHEMA);
    await client.query('COMMIT');
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 748184202)) AS acquired',
      [streamId],
    );
    if (!lock.rows[0]?.acquired) throw new StoreError('collector_already_running');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release(true);
    await pool.end();
    throw error instanceof StoreError ? error : new StoreError('query_failed');
  }

  function ensureOpen(): void {
    if (closed) throw new StoreError('closed');
    if (failed) throw new StoreError('connection_failed');
  }

  // Serialize use of the held session, even when a caller starts queries in
  // parallel; otherwise one call could accidentally join another transaction.
  let queue = Promise.resolve();
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new StoreError('closed'));
    const result = queue.then(async () => {
      ensureOpen();
      try {
        return await operation();
      } catch (error) {
        throw error instanceof StoreError ? error : new StoreError('query_failed');
      }
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    deferRequests(until) {
      if (!isTimestamp(until)) return Promise.reject(new StoreError('invalid_input'));
      return exclusive(async () => {
        await client.query('INSERT INTO market_feed_backoff(stream_id,until_ms) VALUES($1,$2)', [
          streamId,
          until,
        ]);
      });
    },
    requestsNotBefore() {
      return exclusive(async () => {
        const result = await client.query<{ until_ms: string | null }>(
          'SELECT max(until_ms)::text AS until_ms FROM market_feed_backoff WHERE stream_id=$1',
          [streamId],
        );
        const value = result.rows[0]?.until_ms;
        return value === null || value === undefined ? null : Number(value);
      });
    },
    recordRequest(startedAt) {
      if (!isTimestamp(startedAt)) return Promise.reject(new StoreError('invalid_input'));
      return exclusive(async () => {
        await client.query('INSERT INTO market_feed_requests(stream_id,started_at) VALUES($1,$2)', [
          streamId,
          startedAt,
        ]);
      });
    },
    getRecentRequestTimes(since) {
      if (!isTimestamp(since)) return Promise.reject(new StoreError('invalid_input'));
      return exclusive(async () => {
        const result = await client.query<{ started_at: string }>(
          `SELECT started_at::text FROM market_feed_requests WHERE stream_id=$1
            AND started_at >= $2 ORDER BY started_at`,
          [streamId, since],
        );
        return result.rows.map((row) => Number(row.started_at));
      });
    },
    latestScheduledAt() {
      return exclusive(async () => {
        const result = await client.query<{ scheduled_at: string | null }>(
          'SELECT max(scheduled_at)::text AS scheduled_at FROM market_feed_cycles WHERE stream_id=$1',
          [streamId],
        );
        const value = result.rows[0]?.scheduled_at;
        return value === null || value === undefined ? null : Number(value);
      });
    },
    commitCycle(cycle) {
      // Snapshot inputs now so callers cannot mutate them while waiting in queue.
      validateCycle(cycle);
      const payload = JSON.stringify(cycle.outcomes);
      const { id, scheduledAt, completedAt } = cycle;
      const gapFrom = cycle.gapFrom ?? null;
      const count = cycle.outcomes.length;
      return exclusive(async () => {
        await client.query('BEGIN');
        try {
          const inserted = await client.query(
            `INSERT INTO market_feed_cycles(stream_id,cycle_id,scheduled_at,completed_at,outcome_count,gap_from)
             VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING cycle_id`,
            [streamId, id, scheduledAt, completedAt, count, gapFrom],
          );
          if (inserted.rowCount === 0) {
            const match = await client.query<{ same: boolean }>(
              `SELECT (c.cycle_id=$2 AND c.scheduled_at=$3 AND c.completed_at=$4
                AND c.outcome_count=$5 AND c.gap_from IS NOT DISTINCT FROM $7::bigint AND
                (SELECT jsonb_agg(r.outcome ORDER BY r.ordinal) FROM market_feed_records r
                  WHERE r.stream_id=c.stream_id AND r.cycle_id=c.cycle_id)=$6::jsonb) AS same
               FROM market_feed_cycles c WHERE c.stream_id=$1
                 AND (c.cycle_id=$2 OR c.scheduled_at=$3)`,
              [streamId, id, scheduledAt, completedAt, count, payload, gapFrom],
            );
            if (match.rows.length !== 1 || !match.rows[0]?.same) {
              throw new StoreError('cycle_conflict');
            }
            await client.query('COMMIT');
            return false;
          }
          await client.query(
            `INSERT INTO market_feed_records(stream_id,cycle_id,ordinal,token_address,outcome)
             SELECT $1,$2,ordinality,value->>'tokenAddress',value
             FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY`,
            [streamId, id, payload],
          );
          await client.query('COMMIT');
          return true;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {
            failed = true;
          });
          throw error;
        }
      });
    },
    readTokenHistory({ tokenAddress, from, to, limit = 1000 }) {
      if (
        !isKey(tokenAddress) ||
        !isTimestamp(from) ||
        !isTimestamp(to) ||
        to <= from ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 10000
      ) {
        return Promise.reject(new StoreError('invalid_input'));
      }
      return exclusive(async () => {
        const result = await client.query<{
          cycle_id: string;
          scheduled_at: string;
          completed_at: string;
          gap_from: string | null;
          outcome: StorageOutcome;
        }>(
          `SELECT c.cycle_id,c.scheduled_at::text,c.completed_at::text,c.gap_from::text,r.outcome
           FROM market_feed_records r JOIN market_feed_cycles c
             ON c.stream_id=r.stream_id AND c.cycle_id=r.cycle_id
           WHERE r.stream_id=$1 AND r.token_address=$2 AND c.scheduled_at >= $3
             AND c.scheduled_at < $4 ORDER BY c.scheduled_at LIMIT $5`,
          [streamId, tokenAddress, from, to, limit],
        );
        return result.rows.map((row) => ({
          cycleId: row.cycle_id,
          scheduledAt: Number(row.scheduled_at),
          completedAt: Number(row.completed_at),
          ...(row.gap_from === null ? {} : { gapFrom: Number(row.gap_from) }),
          outcome: row.outcome,
        }));
      });
    },
    async close() {
      closing = true;
      await queue;
      if (closed) return;
      closed = true;
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 748184202))', [
          streamId,
        ]);
      } catch {
        // Closing a lost session already releases its server-side lock.
      } finally {
        client.release(true);
        await pool.end();
      }
    },
  };
}
