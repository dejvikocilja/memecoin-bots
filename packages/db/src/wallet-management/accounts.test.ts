import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrateDown, migrateUp, migrationStatus } from '../migrate.js';
import { createPool } from '../pool.js';
import { createTestPool, hasTestDatabase, resetDatabase, TEST_DATABASE_URL } from '../test-db.js';
import {
  getWalletView,
  inspectVault,
  provisionBotWallet,
  recordWalletBalance,
  releaseWalletSpend,
  reserveWalletSpend,
  setWalletCap,
  settleWalletSpend,
} from './accounts.js';
import type { ProvisionOptions } from './accounts.js';
import { createOfflineVault } from './vault.js';
import type { OfflineVault } from './vault.js';
import { ephemeralImport } from './test-support.js';

const profile = `INSERT INTO risk_profiles(id,display_name,position_fraction,stop_loss_fraction,take_profit_ladder,trailing_stop_fraction,min_reward_risk,max_open_positions,daily_loss_limit_fraction,max_slippage_bps,min_liquidity_usd,min_safety_score,max_hold_minutes,losing_streak_limit) VALUES('balanced','Balanced',.02,.2,'[{"atGain":0.3,"sellFraction":0.4},{"atGain":0.6,"sellFraction":0.3}]',.15,2,5,.06,300,50000,60,720,4) ON CONFLICT (id) DO NOTHING`;
describe.skipIf(!hasTestDatabase)('wallet persistence and atomic spending', () => {
  const pool = hasTestDatabase ? createTestPool() : undefined!;
  let dir: string;
  let vault: OfflineVault;
  let key: Buffer;
  const dirs: string[] = [];
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrateUp(pool);
    await pool.query(profile);
    dir = await realpath(await mkdtemp(join(tmpdir(), 'bot-wallet-db-')));
    dirs.push(dir);
    vault = await createOfflineVault(join(dir, 'vault'));
    key = randomBytes(32);
  });
  afterAll(async () => {
    await pool.end();
    await Promise.all(dirs.map((path) => rm(path, { recursive: true, force: true })));
    key?.fill(0);
  });
  function options(overrides: Partial<ProvisionOptions> = {}): ProvisionOptions {
    return {
      bot: {
        name: 'wallet-bot',
        strategy: 'momentum',
        riskProfileId: 'balanced',
        paperBankrollLamports: 1_000n,
      },
      label: 'test hot wallet',
      spendCapLamports: 100n,
      vault,
      encryptionKey: key,
      ...overrides,
    };
  }
  const funded = async (cap = 100n, balance = 100n) => {
    const w = await provisionBotWallet(pool, options({ spendCapLamports: cap }));
    await recordWalletBalance(pool, w.botId, balance, new Date());
    return w;
  };
  it('creates exactly one wallet under concurrent retries and audits only public data', async () => {
    const [a, b] = await Promise.all([
      provisionBotWallet(pool, options()),
      provisionBotWallet(pool, options()),
    ]);
    expect(a).toEqual(b);
    expect(await vault.listIds()).toEqual([a.walletId]);
    expect((await pool.query('SELECT * FROM wallets')).rowCount).toBe(1);
    const audit = (await pool.query('SELECT details FROM audit_log')).rows;
    expect(audit).toEqual([
      { details: { botId: a.botId, publicKey: a.publicKey, spendCapLamports: '100' } },
    ]);
    const dump =
      JSON.stringify((await pool.query('SELECT * FROM wallets')).rows) +
      JSON.stringify(audit) +
      JSON.stringify(a);
    expect(dump).not.toContain(key.toString('base64'));
    expect(dump).not.toContain(dir);
    await expect(provisionBotWallet(pool, options({ label: 'different' }))).rejects.toThrow(
      'RETRY_MISMATCH',
    );
    await expect(
      provisionBotWallet(
        pool,
        options({
          bot: {
            name: 'wallet-bot',
            strategy: 'other',
            riskProfileId: 'balanced',
            paperBankrollLamports: 1_000n,
          },
        }),
      ),
    ).rejects.toThrow('RETRY_MISMATCH');
    await expect(
      pool.query('UPDATE bots SET wallet_id=NULL WHERE id=$1', [a.botId]),
    ).rejects.toThrow(/null/i);
    await expect(
      pool.query(
        `INSERT INTO bots(name,strategy,risk_profile_id,wallet_id) VALUES('second','momentum','balanced',$1)`,
        [a.walletId],
      ),
    ).rejects.toThrow(/unique/i);
  });
  it('imports the expected address and refuses replacing a wallet on retry', async () => {
    const imported = ephemeralImport();
    const w = await provisionBotWallet(pool, options({ imported: imported.input }));
    expect(w.publicKey).toBe(imported.address);
    expect(await provisionBotWallet(pool, options({ bot: { id: w.botId } }))).toEqual(w);
    imported.input.fill(0);
  });
  it('rolls back associations and cleans encrypted files on DB and file failures', async () => {
    await expect(
      provisionBotWallet(
        pool,
        options({
          bot: {
            name: 'broken',
            strategy: 'momentum',
            riskProfileId: 'missing',
            paperBankrollLamports: 0n,
          },
        }),
      ),
    ).rejects.toThrow('PROVISION_FAILED');
    expect(await vault.listIds()).toEqual([]);
    expect((await pool.query('SELECT * FROM wallets')).rowCount).toBe(0);
    const broken: OfflineVault = {
      ...vault,
      provision: async () => {
        throw new Error('synthetic-sensitive-path');
      },
    };
    await expect(provisionBotWallet(pool, options({ vault: broken }))).rejects.toThrow(
      'Wallet operation failed: PROVISION_FAILED.',
    );
    expect((await pool.query('SELECT * FROM bots')).rowCount).toBe(0);
  });
  it('detects crash orphans and missing encrypted files without exposing paths or keys', async () => {
    const w = await provisionBotWallet(pool, options());
    await vault.removeUncommitted(w.walletId);
    const orphan = '12345678-1234-4234-8234-123456789012';
    await vault.provision(orphan, key);
    expect(await inspectVault(pool, vault)).toEqual({
      orphanIds: [orphan],
      missingIds: [w.walletId],
    });
  });
  it('reports physical balance, cumulative allowance and paper bankroll distinctly', async () => {
    const w = await funded(100n, 500n);
    const state = await getWalletView(pool, w.botId);
    expect(state).toMatchObject({
      paperBankrollLamports: '1000',
      observedBalanceLamports: '500',
      usableBalanceLamports: '500',
      spendCapLamports: '100',
      availableLamports: '100',
      fresh: true,
      consumedLamports: '0',
    });
    expect(state.balanceObservedAt).toBeTypeOf('string');
  });
  it('serializes two individually affordable reservations so total cannot exceed cap', async () => {
    const w = await funded(100n, 500n);
    const results = await Promise.allSettled([
      reserveWalletSpend(pool, w.botId, 'one', 60n, 1n),
      reserveWalletSpend(pool, w.botId, 'two', 60n, 1n),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await getWalletView(pool, w.botId)).reservedLamports).toBe('61');
  });
  it('serializes reservations against physical balance including fees', async () => {
    const w = await funded(500n, 100n);
    const results = await Promise.allSettled([
      reserveWalletSpend(pool, w.botId, 'one', 50n, 1n),
      reserveWalletSpend(pool, w.botId, 'two', 50n, 1n),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(reserveWalletSpend(pool, w.botId, 'too-big', 49n, 1n)).rejects.toThrow(
      'SPEND_LIMIT',
    );
    expect((await reserveWalletSpend(pool, w.botId, 'edge', 48n, 1n)).status).toBe('pending');
  });
  it('persists idempotency, settlement and cumulative usage through a new connection', async () => {
    const w = await funded();
    const reservation = await reserveWalletSpend(pool, w.botId, 'same', 60n, 5n);
    expect(await reserveWalletSpend(pool, w.botId, 'same', 60n, 5n)).toEqual(reservation);
    await expect(reserveWalletSpend(pool, w.botId, 'same', 61n, 5n)).rejects.toThrow(
      'RETRY_MISMATCH',
    );
    const settled = await settleWalletSpend(pool, w.botId, reservation.id, 62n);
    expect(settled.status).toBe('settled');
    expect(await settleWalletSpend(pool, w.botId, reservation.id, 62n)).toEqual(settled);
    await expect(settleWalletSpend(pool, w.botId, reservation.id, 61n)).rejects.toThrow(
      'RESERVATION_FINALIZED',
    );
    await expect(releaseWalletSpend(pool, w.botId, reservation.id)).rejects.toThrow(
      'RESERVATION_FINALIZED',
    );
    const fresh = createPool(TEST_DATABASE_URL);
    try {
      expect(await getWalletView(fresh, w.botId)).toMatchObject({
        consumedLamports: '62',
        reservedLamports: '0',
        availableLamports: '38',
        usableBalanceLamports: '38',
      });
    } finally {
      await fresh.end();
    }
    // A refreshed pre-settlement RPC value cannot restore spent funds or cap.
    await recordWalletBalance(pool, w.botId, 100n, new Date());
    expect(await getWalletView(pool, w.botId)).toMatchObject({
      usableBalanceLamports: '38',
      observedBalanceLamports: '100',
      availableLamports: '38',
    });
  });
  it('releases once, cannot settle a released request and rejects excessive settlement', async () => {
    const w = await funded();
    const r = await reserveWalletSpend(pool, w.botId, 'r', 80n, 10n);
    await expect(settleWalletSpend(pool, w.botId, r.id, 91n)).rejects.toThrow(
      'SETTLEMENT_EXCEEDS_RESERVATION',
    );
    const released = await releaseWalletSpend(pool, w.botId, r.id);
    expect(await releaseWalletSpend(pool, w.botId, r.id)).toEqual(released);
    await expect(settleWalletSpend(pool, w.botId, r.id, 80n)).rejects.toThrow(
      'RESERVATION_FINALIZED',
    );
    expect((await getWalletView(pool, w.botId)).availableLamports).toBe('100');
  });
  it('rejects lowering cap below consumed plus pending and audits explicit raises', async () => {
    const w = await funded();
    const r = await reserveWalletSpend(pool, w.botId, 'r', 60n, 5n);
    await settleWalletSpend(pool, w.botId, r.id, 60n);
    await reserveWalletSpend(pool, w.botId, 'next', 20n, 0n);
    await expect(setWalletCap(pool, w.botId, 79n)).rejects.toThrow('CAP_BELOW_USAGE');
    await expect(
      pool.query('UPDATE wallets SET spend_cap_lamports=79 WHERE id=$1', [w.walletId]),
    ).rejects.toThrow(/cap/i);
    await setWalletCap(pool, w.botId, 80n);
    await setWalletCap(pool, w.botId, 200n);
    expect(
      (
        await pool.query(
          "SELECT details FROM audit_log WHERE action='wallet.cap_changed' ORDER BY id",
        )
      ).rows,
    ).toEqual([
      { details: { before: '100', after: '80' } },
      { details: { before: '80', after: '200' } },
    ]);
  });
  it('fails closed for missing, stale, future or out-of-order snapshots and zero/null cap', async () => {
    const w = await provisionBotWallet(pool, options({ spendCapLamports: 0n }));
    await expect(reserveWalletSpend(pool, w.botId, 'missing', 1n, 0n)).rejects.toThrow(
      'BALANCE_UNAVAILABLE',
    );
    await expect(
      recordWalletBalance(pool, w.botId, 100n, new Date(Date.now() + 60_000)),
    ).rejects.toThrow('STALE_BALANCE');
    await expect(
      recordWalletBalance(pool, w.botId, 100n, new Date(Date.now() - 70_000)),
    ).rejects.toThrow('STALE_BALANCE');
    const now = new Date();
    await recordWalletBalance(pool, w.botId, 100n, now);
    await expect(reserveWalletSpend(pool, w.botId, 'zero-cap', 1n, 0n)).rejects.toThrow(
      'SPEND_LIMIT',
    );
    await expect(recordWalletBalance(pool, w.botId, 200n, now)).rejects.toThrow('STALE_BALANCE');
    await setWalletCap(pool, w.botId, 100n);
    await pool.query(
      `UPDATE wallet_spend_state SET balance_observed_at=now()-interval '2 minutes' WHERE wallet_id=$1`,
      [w.walletId],
    );
    expect((await getWalletView(pool, w.botId)).availableLamports).toBe('0');
    await expect(reserveWalletSpend(pool, w.botId, 'stale', 1n, 0n)).rejects.toThrow(
      'BALANCE_UNAVAILABLE',
    );
    // Legacy NULL is disabled, never unlimited (drop cap guard only for legacy simulation).
    await pool.query('ALTER TABLE wallets DISABLE TRIGGER wallets_guard_cap');
    await pool.query('UPDATE wallets SET spend_cap_lamports=NULL WHERE id=$1', [w.walletId]);
    await pool.query('ALTER TABLE wallets ENABLE TRIGGER wallets_guard_cap');
    await recordWalletBalance(pool, w.botId, 100n, new Date());
    await expect(reserveWalletSpend(pool, w.botId, 'null-cap', 1n, 0n)).rejects.toThrow(
      'SPEND_LIMIT',
    );
  });
  it('preserves exact large bigint limits and rejects wrong amount types', async () => {
    const n = 900719925474099300000n;
    const w = await funded(n, n);
    await reserveWalletSpend(pool, w.botId, 'large', n - 1n, 1n);
    expect((await getWalletView(pool, w.botId)).availableLamports).toBe('0');
    for (const bad of [0n, -1n, 1.2, Number.NaN, '1', 10n ** 39n])
      await expect(reserveWalletSpend(pool, w.botId, 'bad', bad as bigint, 0n)).rejects.toThrow(
        'INVALID_AMOUNT',
      );
    await expect(reserveWalletSpend(pool, w.botId, 'bad-fee', 1n, -1n)).rejects.toThrow(
      'INVALID_AMOUNT',
    );
  });
  it('reduces availability after external withdrawal without replenishing on deposits', async () => {
    const w = await funded();
    await reserveWalletSpend(pool, w.botId, 'r', 60n, 0n);
    await recordWalletBalance(pool, w.botId, 50n, new Date());
    expect((await getWalletView(pool, w.botId)).availableLamports).toBe('0');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await recordWalletBalance(pool, w.botId, 500n, new Date());
    expect((await getWalletView(pool, w.botId)).usableBalanceLamports).toBe('50');
  });
  it('runs the public CLI with protected input descriptors and never prints import/master bytes', async () => {
    const imported = ephemeralImport();
    const run = async (command: string, metadata: object, bytes = imported.input) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            '--conditions=@memebots/source',
            fileURLToPath(new URL('./cli.ts', import.meta.url)),
            command,
          ],
          {
            env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
            stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
          },
        );
        let stdout = '',
          stderr = '';
        child.stdout!.on('data', (chunk) => (stdout += String(chunk)));
        child.stderr!.on('data', (chunk) => (stderr += String(chunk)));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin!.end(JSON.stringify(metadata));
        (child.stdio[3] as Writable).end(key);
        (child.stdio[4] as Writable).end(bytes);
      });
    const created = await run('create', {
      name: 'cli bot',
      strategy: 'momentum',
      riskProfileId: 'balanced',
      paperBankrollLamports: '1000',
      label: 'CLI hot wallet',
      spendCapLamports: '100',
      vaultDirectory: join(dir, 'vault'),
      import: true,
    });
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout).publicKey).toBe(imported.address);
    expect(created.stdout + created.stderr).not.toContain(imported.input.toString());
    expect(created.stdout + created.stderr).not.toContain(key.toString('base64'));
    const invalid = await run(
      'create',
      {
        name: 'invalid cli',
        strategy: 'momentum',
        riskProfileId: 'balanced',
        paperBankrollLamports: '1000',
        label: 'test',
        spendCapLamports: '100',
        vaultDirectory: join(dir, 'vault'),
        import: true,
      },
      Buffer.from('synthetic-secret-not-json'),
    );
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).not.toContain('synthetic-secret-not-json');
    expect(invalid.stderr).toContain('PROVISION_FAILED');
    imported.input.fill(0);
  });
  it('rolls back cap and provisioning when same-transaction audit fails', async () => {
    const w = await funded();
    await pool.query(
      `CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit blocked'; END $$; CREATE TRIGGER test_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_test_audit()`,
    );
    await expect(setWalletCap(pool, w.botId, 200n)).rejects.toThrow('DATABASE_OPERATION_FAILED');
    expect((await getWalletView(pool, w.botId)).spendCapLamports).toBe('100');
    await expect(
      provisionBotWallet(
        pool,
        options({
          bot: {
            name: 'audit fails',
            strategy: 'momentum',
            riskProfileId: 'balanced',
            paperBankrollLamports: 0n,
          },
        }),
      ),
    ).rejects.toThrow('PROVISION_FAILED');
    expect(await vault.listIds()).toEqual([w.walletId]);
  });
  it('supports offline pre-migration repair and reversible empty accounting migration', async () => {
    await resetDatabase(pool);
    const migrations = (await loadMigrations()).filter((m) => m.version <= '0008');
    await migrateUp(
      pool,
      migrations.filter((m) => m.version === '0001'),
    );
    await pool.query(profile);
    const bot = (
      await pool.query<{ id: string }>(
        "INSERT INTO bots(name,strategy,risk_profile_id) VALUES('legacy','momentum','balanced') RETURNING id",
      )
    ).rows[0]!.id;
    await expect(migrateUp(pool, migrations)).rejects.toThrow(
      'provision each walletless bot offline',
    );
    const [a, b] = await Promise.all([
      provisionBotWallet(pool, options({ bot: { id: bot } })),
      provisionBotWallet(pool, options({ bot: { id: bot } })),
    ]);
    expect(a).toEqual(b);
    await migrateUp(pool, migrations);
    expect((await getWalletView(pool, bot)).availableLamports).toBe('0');
    await migrateDown(pool, 1, migrations);
    expect(
      (await pool.query('SELECT wallet_id FROM bots WHERE id=$1', [bot])).rows[0].wallet_id,
    ).toBe(a.walletId);
    expect(await vault.listIds()).toEqual([a.walletId]);
    await migrateUp(pool, migrations);
    expect((await migrationStatus(pool, migrations)).every((m) => m.appliedAt)).toBe(true);
  });
  it('requires a matching import when legacy public metadata has no encrypted key', async () => {
    const imported = ephemeralImport();
    const wallet = (
      await pool.query<{ id: string }>(
        'INSERT INTO wallets(label,public_key) VALUES($1,$2) RETURNING id',
        ['legacy', imported.address],
      )
    ).rows[0]!.id;
    await pool.query('INSERT INTO wallet_spend_state(wallet_id) VALUES($1)', [wallet]);
    const bot = (
      await pool.query<{ id: string }>(
        "INSERT INTO bots(name,strategy,risk_profile_id,wallet_id) VALUES('legacy','momentum','balanced',$1) RETURNING id",
        [wallet],
      )
    ).rows[0]!.id;
    await expect(provisionBotWallet(pool, options({ bot: { id: bot } }))).rejects.toThrow(
      'LEGACY_IMPORT_REQUIRED',
    );
    const wrong = ephemeralImport();
    await expect(
      provisionBotWallet(pool, options({ bot: { id: bot }, imported: wrong.input })),
    ).rejects.toThrow('PUBLIC_KEY_MISMATCH');
    expect(await vault.listIds()).toEqual([]);
    expect(
      (await provisionBotWallet(pool, options({ bot: { id: bot }, imported: imported.input })))
        .publicKey,
    ).toBe(imported.address);
    imported.input.fill(0);
    wrong.input.fill(0);
  });
});
