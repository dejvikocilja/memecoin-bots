import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

import type { Pool } from './pool.js';

/**
 * Plain-SQL migrations: `migrations/NNNN_name.up.sql` with a matching
 * `NNNN_name.down.sql`. Each runs in its own transaction and is recorded in
 * `schema_migrations`. An advisory lock stops two processes migrating at once.
 */
export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly up: string;
  readonly down: string;
}

export interface MigrationStatus {
  readonly version: string;
  readonly name: string;
  readonly appliedAt: Date | null;
}

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

// Arbitrary constant shared by every process that migrates this database.
const MIGRATION_LOCK_KEY = 4_812_270_501;

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const byVersion = new Map<string, { name: string; up?: string; down?: string }>();

  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (!match) {
      throw new Error(
        `Migration file "${file}" does not match NNNN_name.up.sql / NNNN_name.down.sql`,
      );
    }
    const [, version, name, direction] = match as unknown as [
      string,
      string,
      string,
      'up' | 'down',
    ];
    const entry = byVersion.get(version) ?? { name };
    if (entry.name !== name) {
      throw new Error(`Migration ${version} has two names: "${entry.name}" and "${name}"`);
    }
    entry[direction] = await readFile(`${dir}/${file}`, 'utf8');
    byVersion.set(version, entry);
  }

  return [...byVersion.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([version, { name, up, down }]) => {
      if (up === undefined || down === undefined) {
        throw new Error(`Migration ${version}_${name} needs both an .up.sql and a .down.sql file`);
      }
      return { version, name, up, down };
    });
}

async function withMigrationLock<T>(
  pool: Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        name        text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    return await fn(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

async function appliedVersions(client: pg.PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

/** Applies every pending migration in order. Returns the versions applied. */
export async function migrateUp(pool: Pool, migrations?: Migration[]): Promise<string[]> {
  const all = migrations ?? (await loadMigrations());
  return withMigrationLock(pool, async (client) => {
    const applied = await appliedVersions(client);
    const done: string[] = [];
    for (const m of all) {
      if (applied.has(m.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.up);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          m.version,
          m.name,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.version}_${m.name} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
      done.push(m.version);
    }
    return done;
  });
}

/** Reverts the last `steps` applied migrations, newest first. Returns the versions reverted. */
export async function migrateDown(
  pool: Pool,
  steps = 1,
  migrations?: Migration[],
): Promise<string[]> {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error(`steps must be a positive whole number, got ${steps}`);
  }
  const all = migrations ?? (await loadMigrations());
  const byVersion = new Map(all.map((m) => [m.version, m]));
  return withMigrationLock(pool, async (client) => {
    const { rows } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT $1',
      [steps],
    );
    const done: string[] = [];
    for (const { version } of rows) {
      const m = byVersion.get(version);
      if (!m) {
        throw new Error(
          `Migration ${version} is applied but its files are missing; cannot revert it`,
        );
      }
      await client.query('BEGIN');
      try {
        await client.query(m.down);
        await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Reverting ${m.version}_${m.name} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
      done.push(version);
    }
    return done;
  });
}

export async function migrationStatus(
  pool: Pool,
  migrations?: Migration[],
): Promise<MigrationStatus[]> {
  const all = migrations ?? (await loadMigrations());
  return withMigrationLock(pool, async (client) => {
    const { rows } = await client.query<{ version: string; applied_at: Date }>(
      'SELECT version, applied_at FROM schema_migrations',
    );
    const appliedAt = new Map(rows.map((r) => [r.version, r.applied_at]));
    return all.map((m) => ({
      version: m.version,
      name: m.name,
      appliedAt: appliedAt.get(m.version) ?? null,
    }));
  });
}
