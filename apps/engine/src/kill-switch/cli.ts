import { createAppContext } from '@memebots/config';
import { createPool, engageKillSwitch, getKillSwitch, releaseKillSwitch } from '@memebots/db';

// BOT-16 operator command, usable when the dashboard is not. Telegram (BOT-26) will call
// the same database functions.
//   pnpm kill status
//   pnpm kill engage [--sell-all]
//   pnpm kill release --confirm "resume buying"
const RELEASE_PHRASE = 'resume buying';
const context = createAppContext(process.env, (line) => process.stdout.write(`${line}\n`));
if (!context) process.exitCode = 1;
else {
  const { config, logger } = context;
  const pool = createPool(config.databaseUrl.reveal(), { max: 2, timeoutMs: 5_000 });
  const [command = 'status', ...args] = process.argv.slice(2);
  try {
    if (command === 'status') {
      logger.info('kill_switch_status', await getKillSwitch(pool));
    } else if (command === 'engage') {
      if (args.some((a) => a !== '--sell-all')) throw new Error('INVALID_ARGUMENTS');
      const started = Date.now();
      const result = await engageKillSwitch(pool, {
        actor: 'owner',
        sellAll: args.includes('--sell-all'),
      });
      logger.info('kill_switch_engaged', { ...result, tookMs: Date.now() - started });
    } else if (command === 'release') {
      if (args.length !== 2 || args[0] !== '--confirm' || args[1] !== RELEASE_PHRASE)
        throw new Error('CONFIRMATION_REQUIRED');
      logger.info('kill_switch_released', await releaseKillSwitch(pool, { actor: 'owner' }));
    } else throw new Error('INVALID_KILL_SWITCH_COMMAND');
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'KILL_SWITCH_FAILED';
    logger.error('kill_switch_command_failed', {
      code,
      usage: `status | engage [--sell-all] | release --confirm "${RELEASE_PHRASE}"`,
    });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
