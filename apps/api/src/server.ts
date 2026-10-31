import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { BotMode } from '@memebots/core';

export interface HealthResponse {
  readonly status: 'ok';
  readonly mode: BotMode;
  readonly liveTradingAvailable: boolean;
}

export interface ServerOptions {
  readonly mode: BotMode;
  readonly logger?: boolean;
}

export function buildServer({ mode, logger = false }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger });

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    mode,
    // Turns true only once the live executor and kill switch exist (BOT-15, BOT-17).
    liveTradingAvailable: false,
  }));

  return app;
}
