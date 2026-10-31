import { createAppContext } from '@memebots/config';

import { createEngine } from './engine.js';

const context = createAppContext(process.env, (line) => process.stdout.write(`${line}\n`));
if (!context) {
  process.exitCode = 1;
} else {
  const { config, logger } = context;
  const engine = createEngine({
    mode: config.mode,
    log: (message) => logger.info('engine_status', { message }),
  });
  engine.start();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      engine.stop();
      process.exit(0);
    });
  }
}
