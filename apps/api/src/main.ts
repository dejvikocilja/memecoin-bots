import { createAppContext } from '@memebots/config';

import { buildServer } from './server.js';

const context = createAppContext(process.env, (line) => process.stdout.write(`${line}\n`));
if (!context) {
  process.exitCode = 1;
} else {
  const { config, logger } = context;
  const app = buildServer({ mode: config.mode, logger });
  try {
    // Fastify normalizes/mutates listen options; validated configuration stays immutable.
    await app.listen({ ...config.api });
    logger.info('api_listening', { host: config.api.host, port: config.api.port });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void app.close().catch(() => {
          process.exitCode = 1;
        });
      });
    }
  } catch (error) {
    logger.error('api_startup_failed', { error });
    process.exitCode = 1;
  }
}
