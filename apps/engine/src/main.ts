import { parseBotMode } from '@memebots/core';

import { createEngine } from './engine.js';

// Config loading moves to the typed loader from BOT-4; until then only BOT_MODE is read.
const engine = createEngine({
  mode: parseBotMode(process.env.BOT_MODE),
  log: (message) => process.stdout.write(`[engine] ${message}\n`),
});

engine.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    engine.stop();
    process.exit(0);
  });
}
