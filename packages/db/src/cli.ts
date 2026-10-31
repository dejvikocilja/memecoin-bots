import { createPool } from './pool.js';
import { migrateDown, migrateUp, migrationStatus } from './migrate.js';

// Usage: pnpm db:migrate [up | down [steps] | status]. Reads DATABASE_URL.
const [command = 'up', arg] = process.argv.slice(2);
const out = (line: string) => process.stdout.write(`${line}\n`);

const pool = createPool(process.env.DATABASE_URL ?? '', { max: 1 });

try {
  if (command === 'up') {
    const applied = await migrateUp(pool);
    out(
      applied.length
        ? `Applied: ${applied.join(', ')}`
        : 'Nothing to apply; the database is up to date.',
    );
  } else if (command === 'down') {
    const reverted = await migrateDown(pool, arg === undefined ? 1 : Number(arg));
    out(reverted.length ? `Reverted: ${reverted.join(', ')}` : 'Nothing to revert.');
  } else if (command === 'status') {
    for (const m of await migrationStatus(pool)) {
      out(
        `${m.version}_${m.name}  ${m.appliedAt ? `applied ${m.appliedAt.toISOString()}` : 'pending'}`,
      );
    }
  } else {
    throw new Error(`Unknown command "${command}". Use: up | down [steps] | status`);
  }
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
