import type { AppLogger, Secret } from '@memebots/config';
import { MONITOR_INTERVAL_MS, observeHealth, pollBotAlerts } from '@memebots/db';
import type { AlertEvent, Queryable } from '@memebots/db';

import { createPollingLoop } from './loop.js';
import { probeRpcHealth } from './rpc-health.js';

/** Run in a separately supervised process. Provider delays never block the stall observer. */
export function createWatchdog(options: {
  readonly db: Queryable;
  readonly logger: AppLogger;
  readonly endpoint?: Secret;
  readonly fetch?: typeof fetch;
}) {
  const reportError = () =>
    options.logger.error('monitoring_poll_failed', { code: 'MONITOR_DB_UNAVAILABLE' });
  const sink = (event: AlertEvent) =>
    options.logger[event.transition === 'opened' ? 'error' : 'info']('monitoring_alert', event);
  const bots = createPollingLoop(
    async () => {
      await pollBotAlerts(options.db, sink);
    },
    MONITOR_INTERVAL_MS,
    reportError,
  );
  const rpc = createPollingLoop(
    async (signal) => {
      const result = await probeRpcHealth(options.endpoint, {
        signal,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      if (signal.aborted || result.status === 'disabled') return;
      await observeHealth(
        options.db,
        'rpc_unhealthy',
        'solana',
        result.status === 'unhealthy',
        result.status === 'unhealthy' ? result.code : 'rpc',
      );
    },
    MONITOR_INTERVAL_MS,
    reportError,
  );
  return {
    start() {
      bots.start();
      rpc.start();
    },
    async stop() {
      await Promise.all([bots.stop(), rpc.stop()]);
    },
  };
}
