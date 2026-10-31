import { parseBotMode } from '@memebots/core';

import { buildServer } from './server.js';

// Config loading moves to the typed loader from BOT-4.
const port = Number(process.env.API_PORT ?? 3001);
// Local hosting (ADR-1): listen on loopback only unless told otherwise.
const host = process.env.API_HOST ?? '127.0.0.1';

const app = buildServer({ mode: parseBotMode(process.env.BOT_MODE), logger: true });

app.listen({ port, host }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
