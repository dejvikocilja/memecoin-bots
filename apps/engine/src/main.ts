import { parseBotMode } from '@memebots/core';

import { createEngine } from './engine.js';
import { createDiscoveryBus } from './market-data/bus.js';
import { discoveryConfig } from './market-data/config.js';
import { createDiscoveryListener } from './market-data/listener.js';

const log = (message: string) => {
  process.stdout.write(`[engine] ${message}\n`);
};
const discovery = createDiscoveryListener({
  config: discoveryConfig(),
  bus: createDiscoveryBus(() => log('discovery subscriber failed')),
  log,
});
const engine = createEngine({ mode: parseBotMode(process.env.BOT_MODE), log, discovery });
engine.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    engine.stop();
    process.exitCode = 0;
  });
}
