import { createPool } from './pool.js';
import type { Pool } from './pool.js';

/**
 * Database tests need a disposable PostgreSQL database in TEST_DATABASE_URL.
 * Its name must end in "_test", because the tests wipe it.
 * Without it the tests are skipped locally; CI sets REQUIRE_DB_TESTS=1 so a
 * missing database fails the run instead of silently skipping.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

if (TEST_DATABASE_URL === '' && process.env.REQUIRE_DB_TESTS === '1') {
  throw new Error('REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is not set');
}

export const hasTestDatabase = TEST_DATABASE_URL !== '';

export function createTestPool(): Pool {
  const name = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against "${name}": the database name must end in "_test"`,
    );
  }
  return createPool(TEST_DATABASE_URL, { max: 4 });
}

/** Drops everything in the public schema. Test databases only. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
