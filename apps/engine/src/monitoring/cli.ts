import { createAppContext } from '@memebots/config';
import { auditStartup, createPool, monitoringHealth } from '@memebots/db';

import { createWatchdog } from './watchdog.js';

const context = createAppContext(process.env, (line) => process.stdout.write(`${line}\n`));
if (!context) process.exitCode = 1;
else {
  const { config, logger } = context;
  const pool = createPool(config.databaseUrl.reveal(), { max: 2, timeoutMs: 2_000 });
  const [command = 'watch'] = process.argv.slice(2);
  let keepOpen = false;
  try {
    if (command === 'health' || command === 'alerts') {
      const health = await monitoringHealth(pool);
      logger.info('monitoring_health', {
        ...health,
        rpc:
          config.discovery.enabled || config.marketData === 'mainnet'
            ? 'probe_enabled_in_watch'
            : 'disabled_offline',
      });
    } else if (command === 'watch') {
      await auditStartup(pool, 'monitor', config);
      const endpoint =
        config.marketData === 'mainnet'
          ? config.providers.heliusRpcUrl
          : config.discovery.enabled
            ? config.discovery.rpcUrl
            : undefined;
      const monitor = createWatchdog({ db: pool, logger, ...(endpoint ? { endpoint } : {}) });
      let stopping = false;
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          if (stopping) return;
          stopping = true;
          void monitor
            .stop()
            .finally(() => pool.end())
            .catch(() => {
              logger.error('monitoring_shutdown_failed', { code: 'MONITOR_DB_UNAVAILABLE' });
              process.exitCode = 1;
            });
        });
      monitor.start();
      keepOpen = true;
      logger.info('monitoring_started', {
        rpc: endpoint ? 'probe_enabled' : 'disabled_offline',
        intervalMs: 5_000,
      });
    } else throw new Error('INVALID_MONITOR_COMMAND');
  } catch {
    logger.error('monitoring_startup_failed', {
      code: 'MONITOR_STARTUP_FAILED',
      usage: 'watch | health | alerts',
    });
    process.exitCode = 1;
  } finally {
    if (!keepOpen) await pool.end();
  }
}
