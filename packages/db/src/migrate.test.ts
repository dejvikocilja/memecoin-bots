import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadMigrations, migrateDown, migrateUp, migrationStatus } from './migrate.js';
import { createTestPool, hasTestDatabase, resetDatabase } from './test-db.js';

const EXPECTED_TABLES = [
  'audit_log',
  'bots',
  'fills',
  'orders',
  'positions',
  'risk_profiles',
  'schema_migrations',
  'tokens',
  'wallets',
];

describe.skipIf(!hasTestDatabase)('migrations', () => {
  const pool = hasTestDatabase ? createTestPool() : undefined!;

  async function tables(): Promise<string[]> {
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    return rows.map((r) => r.tablename);
  }

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('every migration has an up and a down file', async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((m) => m.version)).toContain('0001');
    for (const m of migrations) {
      expect(m.up.trim()).not.toBe('');
      expect(m.down.trim()).not.toBe('');
    }
  });

  it('runs up, is idempotent, runs down, and runs up again', async () => {
    const all = (await loadMigrations()).map((m) => m.version);

    expect(await migrateUp(pool)).toEqual(all);
    expect(await tables()).toEqual(EXPECTED_TABLES);
    expect(await migrateUp(pool)).toEqual([]);

    expect(await migrateDown(pool, all.length)).toEqual([...all].reverse());
    expect(await tables()).toEqual(['schema_migrations']);
    expect((await migrationStatus(pool)).every((m) => m.appliedAt === null)).toBe(true);

    expect(await migrateUp(pool)).toEqual(all);
    expect(await tables()).toEqual(EXPECTED_TABLES);
  });

  it('two processes migrating at once apply each migration exactly once', async () => {
    const [a, b] = await Promise.all([migrateUp(pool), migrateUp(pool)]);
    const all = (await loadMigrations()).map((m) => m.version);
    expect([...a, ...b].sort()).toEqual(all);
  });

  it('rejects a nonsense step count', async () => {
    await expect(migrateDown(pool, 0)).rejects.toThrow(/positive whole number/);
  });
});
