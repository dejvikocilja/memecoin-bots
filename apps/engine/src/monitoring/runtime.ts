import { randomUUID } from 'node:crypto';

import type { AppLogger } from '@memebots/config';
import {
  acquireBotLeases,
  HEARTBEAT_INTERVAL_MS,
  observeHealth,
  publishBotProgress,
  releaseBotLeases,
} from '@memebots/db';
import type { BotLease, Pool } from '@memebots/db';

import { createPollingLoop, withinDeadline } from './loop.js';

export interface ManagedBotTick {
  /** Future strategies must await their real work before this promise resolves and honor cancellation. */
  (botId: string, signal: AbortSignal): Promise<void>;
}

/** The current managed tick verifies persisted bot policy; it does not execute strategies or orders. */
export function createBotRuntime(options: {
  readonly pool: Pool;
  readonly logger: AppLogger;
  readonly tick?: ManagedBotTick;
}) {
  const ownerId = randomUUID();
  let leases: BotLease[] = [];
  let started = false;
  // The deadline cancels observation, not an adapter's underlying promise. Keep a
  // timed-out bot quarantined until that promise settles, including across stop/start.
  const pendingTicks = new Map<string, Promise<void>>();
  const discoveryFailures = new Set<'transport' | 'rpc'>();
  let discoveryObserved = false;
  const loop = createPollingLoop(
    async (signal) => {
      for (const lease of leases) {
        if (pendingTicks.has(lease.botId)) continue;
        try {
          await withinDeadline(
            (tickSignal) => {
              const work = (async () => {
                const bot = await options.pool.query<{ mode: string }>(
                  'SELECT mode FROM bots WHERE id = $1',
                  [lease.botId],
                );
                if (bot.rows[0]?.mode !== 'paper') return;
                tickSignal.throwIfAborted();
                if (options.tick) await options.tick(lease.botId, tickSignal);
                tickSignal.throwIfAborted();
                await publishBotProgress(
                  options.pool,
                  lease,
                  options.tick ? 'strategy' : 'scaffold',
                );
              })();
              pendingTicks.set(lease.botId, work);
              const clear = () => {
                if (pendingTicks.get(lease.botId) === work) pendingTicks.delete(lease.botId);
              };
              void work.then(clear, clear);
              return work;
            },
            signal,
            5_000,
          );
        } catch {
          if (!signal.aborted)
            options.logger.error('bot_tick_failed', {
              botId: lease.botId,
              code: 'BOT_PROGRESS_UNCONFIRMED',
            });
        }
      }
      if (signal.aborted) return;
      if (discoveryObserved)
        await observeHealth(
          options.pool,
          'discovery_unhealthy',
          'discovery',
          discoveryFailures.size > 0,
          discoveryFailures.has('transport') ? 'transport' : 'rpc',
        );
    },
    HEARTBEAT_INTERVAL_MS,
    () => options.logger.error('engine_monitoring_failed', { code: 'MONITOR_DB_UNAVAILABLE' }),
  );
  return {
    async start() {
      if (started) return;
      leases = await acquireBotLeases(options.pool, ownerId);
      started = true;
      loop.start();
    },
    async stop() {
      if (!started) return;
      started = false;
      await loop.stop();
      await releaseBotLeases(options.pool, ownerId);
      leases = [];
    },
    /** Fixed status only; called by discovery transport/RPC transitions, never market-event frequency. */
    discoveryHealth(failed: boolean, code: 'transport' | 'rpc') {
      discoveryObserved = true;
      if (failed) discoveryFailures.add(code);
      else discoveryFailures.delete(code);
    },
  };
}
