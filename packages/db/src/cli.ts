import { createAppContext } from '@memebots/config';

import { createPool } from './pool.js';
import { migrateDown, migrateUp, migrationStatus } from './migrate.js';

// Usage: pnpm db:migrate | db:status | db:rollback [steps].
// DATABASE_URL is validated by the shared config loader (BOT-4): loopback only, and
// the URL and its password are registered so the logger never prints them.
const [command = 'up', arg] = process.argv.slice(2);

const context = createAppContext(process.env, (line) => process.stdout.write(`${line}\n`));
if (!context) {
  process.exitCode = 1;
} else {
  const { config, logger } = context;
  const pool = createPool(config.databaseUrl.reveal(), { max: 1 });
  try {
    if (command === 'up') {
      logger.info('db_migrate_up', { applied: await migrateUp(pool) });
    } else if (command === 'down') {
      logger.info('db_migrate_down', {
        reverted: await migrateDown(pool, arg === undefined ? 1 : Number(arg)),
      });
    } else if (command === 'status') {
      const status = await migrationStatus(pool);
      logger.info('db_migrate_status', {
        migrations: status.map((m) => ({
          migration: `${m.version}_${m.name}`,
          appliedAt: m.appliedAt?.toISOString() ?? null,
        })),
      });
    } else {
      logger.error('db_migrate_unknown_command', { command, usage: 'up | down [steps] | status' });
      process.exitCode = 1;
    }
  } catch (err) {
    // The logger redacts the registered database URL and password from the message.
    logger.error('db_migrate_failed', { command, message: (err as Error).message });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
