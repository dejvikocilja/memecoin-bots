import type { BotMode } from '@memebots/core';

export type LogFn = (message: string) => void;

export interface EngineOptions {
  readonly mode: BotMode;
  readonly log: LogFn;
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
 * Live mode is refused until the live executor and kill switch exist: there is
 * no code path in this scaffold that can move real funds.
 */
export function createEngine({ mode, log }: EngineOptions): Engine {
  if (mode === 'live') {
    throw new Error(
      'Live mode is not available yet: the live executor and kill switch are not built.',
    );
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
      log(`engine started in ${mode} mode`);
    },
    stop() {
      if (!running) return;
      running = false;
      log('engine stopped');
    },
  };
}
