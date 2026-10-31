import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { openPostgresSnapshotStore, StoreError } from './store.js';
import type { StoredCycle } from './store.js';
import type { TokenSnapshot } from './types.js';

const databaseUrl = process.env.MARKET_DATA_TEST_DATABASE_URL;
if (process.env.REQUIRE_MARKET_DATA_DB_TESTS === '1' && !databaseUrl) {
  throw new Error('MARKET_DATA_TEST_DATABASE_URL is required for market data DB tests');
}

describe.skipIf(!databaseUrl)('PostgreSQL market data history', () => {
  const options = () => ({ connectionString: databaseUrl!, streamId: randomUUID() });
  const cycle = (scheduledAt = 30000): StoredCycle => ({
    id: `cycle:${scheduledAt}`,
    scheduledAt,
    completedAt: scheduledAt + 1,
    outcomes: [
      { status: 'unavailable', tokenAddress: 'mint-a', reason: 'missing' },
      { status: 'unavailable', tokenAddress: 'mint-b', reason: 'quota_exhausted' },
    ],
  });

  it('restores checkpoints and gaps from a new connection and deduplicates a replay', async () => {
    const config = options();
    let store = await openPostgresSnapshotStore(config);
    try {
      expect(await store.latestScheduledAt()).toBeNull();
      expect(await store.commitCycle(cycle())).toBe(true);
      expect(await store.commitCycle(cycle())).toBe(false);
      expect(await store.latestScheduledAt()).toBe(30000);
    } finally {
      await store.close();
    }
    store = await openPostgresSnapshotStore(config);
    try {
      expect(await store.latestScheduledAt()).toBe(30000);
      const next = { ...cycle(90000), gapFrom: 60000 };
      expect(await store.commitCycle(next)).toBe(true);
      expect(await store.readTokenHistory({ tokenAddress: 'mint-a', from: 0, to: 90001 })).toEqual([
        {
          cycleId: 'cycle:30000',
          scheduledAt: 30000,
          completedAt: 30001,
          outcome: cycle().outcomes[0],
        },
        {
          cycleId: 'cycle:90000',
          scheduledAt: 90000,
          completedAt: 90001,
          gapFrom: 60000,
          outcome: next.outcomes[0],
        },
      ]);
      // End-exclusive ranges and bounded history support deterministic backtests.
      expect(
        await store.readTokenHistory({ tokenAddress: 'mint-a', from: 0, to: 90000, limit: 1 }),
      ).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('holds a session lock, rejects a second collector, and releases it on close', async () => {
    const config = options();
    const first = await openPostgresSnapshotStore(config);
    try {
      await expect(openPostgresSnapshotStore(config)).rejects.toMatchObject({
        code: 'collector_already_running',
      });
    } finally {
      await first.close();
    }
    const replacement = await openPostgresSnapshotStore(config);
    await replacement.close();
    await replacement.close();
    await expect(replacement.latestScheduledAt()).rejects.toMatchObject({ code: 'closed' });
  });

  it('persists request quota before a cycle is committed and restores it after restart', async () => {
    const config = options();
    let store = await openPostgresSnapshotStore(config);
    try {
      await store.recordRequest(10000);
      await store.recordRequest(20000);
      await store.recordRequest(90000);
      expect(await store.latestScheduledAt()).toBeNull();
    } finally {
      await store.close();
    }
    store = await openPostgresSnapshotStore(config);
    try {
      expect(await store.getRecentRequestTimes(20000)).toEqual([20000, 90000]);
      // An invalid timestamp cannot silently poison the durable quota meter.
      await expect(store.recordRequest(Number.NaN)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    } finally {
      await store.close();
    }
  });

  it('preserves exact price strings, timestamps, and unknown metrics for later backtests', async () => {
    const store = await openPostgresSnapshotStore(options());
    const snapshot: TokenSnapshot = {
      schemaVersion: 1,
      source: 'dexscreener',
      chain: 'solana',
      tokenAddress: 'mint-a',
      pairAddress: 'pool-a',
      dexId: 'dex-a',
      observedAt: 30001,
      receivedAt: 30001,
      sourceTimestamp: null,
      priceUsd: '0.000000000000000000001234567890123456789',
      liquidityUsd: 12345.67,
      windows: {
        m1: { volumeUsd: null, buyTransactions: null, uniqueBuyers: null },
        m5: { volumeUsd: 100, buyTransactions: 7, uniqueBuyers: null },
        h1: { volumeUsd: 200, buyTransactions: 12, uniqueBuyers: null },
      },
      quality: {
        sourceFreshness: 'unknown',
        timestampBasis: 'received_at',
        m1: 'not_provided',
        uniqueBuyers: 'not_provided',
        buyTransactions: 'transaction_count_not_unique_buyers',
        pairSelection: 'highest_known_liquidity_usd_then_pair_address',
      },
    };
    try {
      await store.commitCycle({
        ...cycle(),
        outcomes: [{ status: 'ok', tokenAddress: 'mint-a', snapshot }],
      });
      const history = await store.readTokenHistory({ tokenAddress: 'mint-a', from: 0, to: 90000 });
      expect(history[0]?.outcome).toEqual({ status: 'ok', tokenAddress: 'mint-a', snapshot });
    } finally {
      await store.close();
    }
  });

  it('retains the longest provider backoff across collector restarts', async () => {
    const config = options();
    let store = await openPostgresSnapshotStore(config);
    try {
      expect(await store.requestsNotBefore()).toBeNull();
      await store.deferRequests(120000);
      await store.deferRequests(60000);
    } finally {
      await store.close();
    }
    store = await openPostgresSnapshotStore(config);
    try {
      expect(await store.requestsNotBefore()).toBe(120000);
    } finally {
      await store.close();
    }
  });

  it('rejects conflicting retries without overwriting a checkpoint or history', async () => {
    const store = await openPostgresSnapshotStore(options());
    try {
      await store.commitCycle(cycle());
      await expect(store.commitCycle({ ...cycle(), completedAt: 30002 })).rejects.toMatchObject({
        code: 'cycle_conflict',
      });
      await expect(store.commitCycle({ ...cycle(), id: 'different-id' })).rejects.toMatchObject({
        code: 'cycle_conflict',
      });
      expect(await store.latestScheduledAt()).toBe(30000);
      expect(
        await store.readTokenHistory({ tokenAddress: 'mint-b', from: 0, to: 90000 }),
      ).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('rolls back the entire cycle if recording its outcomes fails', async () => {
    // Only run against a dedicated test database. The trigger affects this unique
    // stream and injects a disk/write-style failure after the cycle insert.
    const config = options();
    const store = await openPostgresSnapshotStore(config);
    const client = new pg.Client({ connectionString: databaseUrl! });
    await client.connect();
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `market_feed_test_fail_${suffix}`;
    const triggerName = `market_feed_test_trigger_${suffix}`;
    try {
      // The generated identifier/UUID contain hex characters only; no user input
      // is interpolated into this test-only DDL.
      await client.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.stream_id = '${config.streamId}' THEN RAISE EXCEPTION 'test write failure';
        END IF; RETURN NEW; END; $$`);
      await client.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON market_feed_records
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      await expect(store.commitCycle(cycle())).rejects.toBeInstanceOf(StoreError);
      expect(await store.latestScheduledAt()).toBeNull();
      expect(await store.readTokenHistory({ tokenAddress: 'mint-a', from: 0, to: 90000 })).toEqual(
        [],
      );
    } finally {
      await client.query(`DROP TRIGGER IF EXISTS ${triggerName} ON market_feed_records`);
      await client.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await client.end();
      await store.close();
    }
  });

  it('the database itself refuses edits or deletion of recorded history', async () => {
    const config = options();
    const store = await openPostgresSnapshotStore(config);
    const client = new pg.Client({ connectionString: databaseUrl! });
    await client.connect();
    try {
      await store.commitCycle(cycle());
      await expect(
        client.query('UPDATE market_feed_cycles SET cycle_id=cycle_id WHERE stream_id=$1', [
          config.streamId,
        ]),
      ).rejects.toThrow('append-only');
      await expect(
        client.query('DELETE FROM market_feed_records WHERE stream_id=$1', [config.streamId]),
      ).rejects.toThrow('append-only');
      expect(await store.latestScheduledAt()).toBe(30000);
    } finally {
      await client.end();
      await store.close();
    }
  });
});
