import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Secret } from '@memebots/config';
import { loadMigrations, migrateDown, migrateUp, migrationStatus } from './migrate.js';
import { SafetyStore } from './safety.js';
import { createTestPool, hasTestDatabase, resetDatabase } from './test-db.js';
import { SafetyScanner } from '../../../apps/engine/src/safety/service.js';
import { SafetyRpc } from '../../../apps/engine/src/safety/rpc.js';
import { runSafetyCli } from '../../../apps/engine/src/safety/cli.js';
import { DEFAULT_POLICY } from '../../../apps/engine/src/safety/evidence.js';
import { goodScenario, FIXTURE_MINT } from '../../../apps/engine/src/safety/fixtures.js';
import { rpcFixture } from '../../../apps/engine/src/safety/rpc-fixtures.js';

describe.skipIf(!hasTestDatabase)('durable token safety pipeline', () => {
  const pool = hasTestDatabase ? createTestPool() : undefined!;
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrateUp(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  const key = `solana:${FIXTURE_MINT}:none`;
  it('refreshes once, survives restart, reruns strict policy and persists separate policy history', async () => {
    let calls = 0;
    const collect = async () => {
      calls++;
      return goodScenario();
    };
    const store = new SafetyStore(pool);
    const scanner = new SafetyScanner(store, collect);
    const [a, b] = await Promise.all([scanner.scan(FIXTURE_MINT), scanner.scan(FIXTURE_MINT)]);
    expect(a.decision.passed).toBe(true);
    expect(b.snapshotId).toBe(a.snapshotId);
    expect(calls).toBe(1);
    const strict = await new SafetyScanner(new SafetyStore(pool), collect).scan(
      FIXTURE_MINT,
      null,
      { ...DEFAULT_POLICY, maxOwnerBps: 499 },
    );
    expect(calls).toBe(1);
    expect(strict.decision.passed).toBe(false);
    expect(strict.snapshotId).toBe(a.snapshotId);
    const rows = await pool.query(
      'SELECT DISTINCT policy_fingerprint FROM token_safety_evaluations',
    );
    expect(rows.rowCount).toBe(2);
    const summary = await pool.query('SELECT safety_details FROM tokens WHERE mint=$1', [
      FIXTURE_MINT,
    ]);
    expect(summary.rows[0].safety_details.policyFingerprint).toBe(
      strict.decision.policyFingerprint,
    );
  });
  it('coordinates independent processes, recovers expired leases and rejects an older fenced writer', async () => {
    const a = new SafetyStore(pool);
    const b = new SafetyStore(pool);
    const leases = await Promise.all([a.acquire(key), b.acquire(key)]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    const old = leases.find(Boolean)!;
    await pool.query(
      "UPDATE token_safety_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE cache_key=$1",
      [key],
    );
    const newer = (await b.acquire(key))!;
    expect(newer.id).not.toBe(old.id);
    const e = goodScenario();
    const input = {
      key,
      mint: FIXTURE_MINT,
      evidence: e,
      expiresAt: e.checks.lp.expiresAt,
      refreshMs: 60000,
    };
    const id = await b.save({ ...input, lease: newer });
    expect(id).not.toBeNull();
    expect(await a.save({ ...input, lease: old })).toBeNull();
    expect((await a.read(key))!.id).toBe(id);
    const late = (await a.acquire(key))!;
    await pool.query(
      "UPDATE token_safety_leases SET started_at=clock_timestamp()-interval '1 minute' WHERE cache_key=$1",
      [key],
    );
    expect(await a.save({ ...input, lease: late })).toBeNull();
    expect((await a.read(key))!.id).toBe(id);
    await a.release(key, late);
    await expect(
      pool.query("UPDATE token_safety_snapshots SET evidence='{}'::jsonb"),
    ).rejects.toThrow('append-only');
  });
  it('expired evidence cannot pass while another refresher holds the lease; malformed cache denies', async () => {
    const scanner = new SafetyScanner(new SafetyStore(pool), async () => goodScenario());
    await scanner.scan(FIXTURE_MINT);
    // Expiry is enforced per check even if a cache refresh timestamp was corrupted/stale.
    const later = Date.now() + 61000;
    const store = new SafetyStore(pool);
    const expired = await new SafetyScanner(
      store,
      async () => {
        throw new Error('not called');
      },
      () => later,
    ).scan(FIXTURE_MINT);
    expect(expired.decision.passed).toBe(false);
    expect(expired.decision.checks.lp.reason).toBe('EXPIRED');
    await pool.query(
      "UPDATE token_safety_cache SET refresh_after=clock_timestamp()-interval '1 second'",
    );
    const lease = await store.acquire(key);
    expect(lease).not.toBeNull();
    const pending = await new SafetyScanner(
      store,
      async () => {
        throw new Error('not called');
      },
      () => later,
    ).scan(FIXTURE_MINT);
    expect(pending.refresh).toBe('pending');
    expect(pending.decision.passed).toBe(false);
    await store.release(key, lease!);
  });
  it('malformed persisted cache is never trusted as passing evidence', async () => {
    const store = new SafetyStore(pool);
    const lease = (await store.acquire(key))!;
    await store.save({
      key,
      mint: FIXTURE_MINT,
      evidence: { passed: true },
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      refreshMs: 60000,
      lease,
    });
    const result = await new SafetyScanner(store, async () => goodScenario()).scan(FIXTURE_MINT);
    expect(result.decision.passed).toBe(false);
    expect(result.decision.checks.mintAuthority.reason).toBe('INVALID_EVIDENCE');
    expect(result.snapshotId).toBeNull();
  });
  it('persists a short negative cache after collection failure instead of repeatedly requesting', async () => {
    let calls = 0;
    const scanner = new SafetyScanner(new SafetyStore(pool), async () => {
      calls++;
      throw new Error('PRIVATE_PROVIDER_ERROR');
    });
    const a = await scanner.scan(FIXTURE_MINT);
    const b = await scanner.scan(FIXTURE_MINT);
    expect(calls).toBe(1);
    expect(a.snapshotId).toBe(b.snapshotId);
    expect(a.decision.checks.mintAuthority).toEqual({
      status: 'unknown',
      reason: 'RPC_UNAVAILABLE',
    });
    expect(JSON.stringify(a)).not.toContain('PRIVATE_PROVIDER_ERROR');
    const cached = (await new SafetyStore(pool).read(key))!;
    expect(cached.expiresAt.getTime() - cached.now.getTime()).toBeLessThanOrEqual(
      DEFAULT_POLICY.negativeCacheMs,
    );
  });
  it('independent scanner instances coalesce through the DB lease and deny pending first scans', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const collect = async () => {
      calls++;
      await gate;
      return goodScenario();
    };
    const a = new SafetyScanner(new SafetyStore(pool), collect);
    const b = new SafetyScanner(new SafetyStore(pool), collect);
    const pending = a.scan(FIXTURE_MINT);
    // Wait on observable lease state, bounded without timing-sensitive sleeps.
    for (let i = 0; i < 100; i++) {
      if ((await pool.query('SELECT 1 FROM token_safety_leases')).rowCount) break;
    }
    try {
      const denied = await b.scan(FIXTURE_MINT);
      expect(denied.refresh).toBe('pending');
      expect(denied.decision.passed).toBe(false);
    } finally {
      release();
    }
    expect((await pending).decision.passed).toBe(true);
    expect(calls).toBe(1);
  });
  it('transaction rollback leaves no partial evaluation, token summary or audit entry', async () => {
    const store = new SafetyStore(pool);
    const a = await new SafetyScanner(store, async () => goodScenario()).scan(FIXTURE_MINT);
    const before = await pool.query('SELECT count(*) FROM token_safety_evaluations');
    await pool.query(
      "CREATE FUNCTION reject_safety_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='safety.passed' THEN RAISE EXCEPTION 'test injected failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_safety_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_safety_audit()",
    );
    await expect(
      new SafetyScanner(store, async () => goodScenario()).scan(FIXTURE_MINT),
    ).rejects.toThrow('test injected failure');
    expect((await pool.query('SELECT count(*) FROM token_safety_evaluations')).rows).toEqual(
      before.rows,
    );
    expect((await store.read(key))!.id).toBe(a.snapshotId);
  });
  it('CLI executes actual local mock-RPC to PostgreSQL to redacted machine report', async () => {
    const methods: string[] = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const q = JSON.parse(body) as { method: string; id: number };
      methods.push(q.method);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: rpcFixture(q.method) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/?credential=DO_NOT_REPORT`;
    const lines: string[] = [];
    try {
      const code = await runSafetyCli(
        [FIXTURE_MINT, '--once'],
        { DATABASE_URL: process.env.TEST_DATABASE_URL, SOLANA_RPC_URL: endpoint },
        (line) => lines.push(line),
      );
      expect(code).toBe(0);
      expect(methods).toEqual([
        'getAccountInfo',
        'getTokenSupply',
        'getTokenLargestAccounts',
        'getMultipleAccounts',
      ]);
      const report = JSON.parse(lines[0]!).fields;
      expect(report.decision.passed).toBe(false);
      expect(report.decision.scenario).toBe(false);
      expect(report.decision.checks.lp).toEqual({ status: 'unknown', reason: 'UNSUPPORTED' });
      expect((await pool.query('SELECT count(*) FROM token_safety_snapshots')).rows[0].count).toBe(
        '1',
      );
      expect(
        (await pool.query("SELECT count(*) FROM audit_log WHERE action='safety.denied'")).rows[0]
          .count,
      ).toBe('1');
      expect(JSON.stringify(lines)).not.toContain('DO_NOT_REPORT');
      const restart = new SafetyScanner(new SafetyStore(pool), async (m, p, t) =>
        new SafetyRpc(new Secret(endpoint)).collect(m, p, t),
      );
      await restart.scan(FIXTURE_MINT);
      expect(methods).toHaveLength(4);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
  it('migration0009 rolls down and up and exposes status', async () => {
    expect(
      (await migrationStatus(pool)).find((m) => m.version === '0009')!.appliedAt,
    ).not.toBeNull();
    const later = (await loadMigrations()).filter((m) => m.version > '0009');
    if (later.length) await migrateDown(pool, later.length);
    expect(await migrateDown(pool)).toEqual(['0009']);
    expect((await migrationStatus(pool)).find((m) => m.version === '0009')!.appliedAt).toBeNull();
    expect(await migrateUp(pool)).toEqual(['0009', ...later.map((m) => m.version)]);
  });
});
