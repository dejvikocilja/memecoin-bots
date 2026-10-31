import { createAppContext } from '@memebots/config';
import { auditStartup, createPool } from '@memebots/db';

import { createEngine } from './engine.js';
import { createDiscoveryBus } from './market-data/bus.js';
import { discoveryConfig } from './market-data/config.js';
import { createDiscoveryListener } from './market-data/listener.js';
import { createBotRuntime } from './monitoring/runtime.js';

const context = createAppContext(process.env, (line) => process.stdout.write(`${line}\n`));
if (!context) {
  process.exitCode = 1;
} else {
  const { config, logger } = context;
  const pool = createPool(config.databaseUrl.reveal(), { max: 2, timeoutMs: 5_000 });
  const runtime = createBotRuntime({ pool, logger });
  const log = (message: string) => logger.info('engine_status', { message });
  const discovery = createDiscoveryListener({
    config: discoveryConfig(config.discovery),
    bus: createDiscoveryBus(() => logger.error('discovery_subscriber_failed')),
    log,
    onHealth: (failed, code) => runtime.discoveryHealth(failed, code),
  });
  const engine = createEngine({ mode: config.mode, log, discovery });
  try {
    // Never run without durable boot/config evidence. Config values are explicitly whitelisted.
    await auditStartup(pool, 'engine', config);
    await runtime.start();
    engine.start();
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        if (stopping) return;
        stopping = true;
        engine.stop();
        void runtime
          .stop()
          .finally(() => pool.end())
          .catch(() => {
            logger.error('engine_shutdown_failed', { code: 'ENGINE_SHUTDOWN_FAILED' });
            process.exitCode = 1;
          });
      });
    }
  } catch {
    engine.stop();
    await runtime.stop().catch(() => {});
    await pool.end();
    logger.error('engine_startup_failed', { code: 'DURABLE_STARTUP_FAILED' });
    process.exitCode = 1;
  }
}
