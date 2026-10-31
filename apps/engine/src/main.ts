import { createAppContext } from '@memebots/config';

import { createEngine } from './engine.js';
import { createDiscoveryBus } from './market-data/bus.js';
import { discoveryConfig } from './market-data/config.js';
import { createDiscoveryListener } from './market-data/listener.js';

const context = createAppContext(process.env, (line) => process.stdout.write(`${line}\n`));
if (!context) {
  process.exitCode = 1;
} else {
  const { config, logger } = context;
  const log = (message: string) => logger.info('engine_status', { message });
  const discovery = createDiscoveryListener({
    config: discoveryConfig(config.discovery),
    bus: createDiscoveryBus(() => logger.error('discovery_subscriber_failed')),
    log,
  });
  const engine = createEngine({ mode: config.mode, log, discovery });
  engine.start();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      engine.stop();
      process.exitCode = 0;
    });
  }
}
