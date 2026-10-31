import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAppContext } from '@memebots/config';

import { buildServer } from './server.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('reports the mode and that live trading is not available', async () => {
    app = buildServer({ mode: 'paper' });
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', mode: 'paper', liveTradingAvailable: false });
  });

  it('redacts provider failures in the real HTTP log sink and hides them in responses', async () => {
    const secret = 'synthetic-http-provider-key-713';
    const password = 'synthetic-http-db-password-825';
    const logs: string[] = [];
    const context = createAppContext(
      { DATABASE_URL: `postgresql://bot:${password}@127.0.0.1/bot`, HELIUS_API_KEY: secret },
      (line) => logs.push(line),
    );
    expect(context).toBeDefined();
    app = buildServer({ mode: context!.config.mode, logger: context!.logger });
    app.get('/synthetic-failure', async () => {
      throw new Error(
        `Failed https://mainnet.helius-rpc.com/?api-key=${secret} database password ${password}`,
      );
    });
    const response = await app.inject({
      method: 'GET',
      url: `/synthetic-failure?api-key=${secret}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal server error' });
    expect(logs.some((line) => JSON.parse(line).event === 'http_request_failed')).toBe(true);
    for (const value of [secret, password])
      expect(logs.join('\n') + response.body).not.toContain(value);
  });
});
