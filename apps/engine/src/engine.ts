import type { BotMode } from '@memebots/core';

import type { DiscoveryListener } from './market-data/listener.js';

export type LogFn = (message: string) => void;

export interface EngineOptions {
  readonly mode: BotMode;
  readonly log: LogFn;
  readonly discovery?: DiscoveryListener;
}

export interface Engine {
  readonly mode: BotMode;
  readonly running: boolean;
  start(): void;
  stop(): void;
}

/**
 * Scaffold of the bot engine. Later tasks plug in the market data feed (BOT-6/7),
 * strategies (BOT-19+), the risk manager (BOT-13) and the executors (BOT-16/17).
 *
 * Live mode is refused until the live executor exists (the kill switch is BOT-16): there is
 * no code path in this scaffold that can move real funds.
 */
export function createEngine({ mode, log, discovery }: EngineOptions): Engine {
  if (mode === 'live') {
    throw new Error('Live mode is not available yet: the live executor is not built.');
  }

  let running = false;

  return {
    mode,
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      if (mode !== 'off') discovery?.start();
      log(`engine started in ${mode} mode`);
    },
    stop() {
      if (!running) return;
      running = false;
      discovery?.stop();
      log('engine stopped');
    },
  };
}
