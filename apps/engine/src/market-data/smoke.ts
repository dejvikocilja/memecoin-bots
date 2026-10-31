/** Bounded opt-in read-only smoke using the shared configuration/logging boundary. */
import { createAppContext } from '@memebots/config';

import { createDiscoveryBus } from './bus.js';
import { discoveryConfig } from './config.js';
import { createDiscoveryListener } from './listener.js';

const context = createAppContext(process.env, (line) => process.stdout.write(`${line}\n`));
const argument = process.argv.slice(2);
const duration =
  argument.length === 2 && argument[0] === '--duration-ms' ? Number(argument[1]) : 30_000;
if (!context) {
  process.exitCode = 1;
} else if (
  !Number.isInteger(duration) ||
  duration < 1_000 ||
  duration > 300_000 ||
  (argument.length !== 0 && (argument.length !== 2 || argument[0] !== '--duration-ms'))
) {
  context.logger.error('discovery_smoke_usage', { usage: '--duration-ms <1000..300000>' });
  process.exitCode = 1;
} else {
  const { logger, config } = context;
  const startedAt = Date.now();
  const bus = createDiscoveryBus(() => logger.error('discovery_subscriber_failed'));
  const counts: Record<string, number> = {};
  bus.subscribe((event) => {
    counts[`${event.protocol}:${event.kind}`] =
      (counts[`${event.protocol}:${event.kind}`] ?? 0) + 1;
  });
  const listener = createDiscoveryListener({
    // Explicit smoke invocation opts in only after the entire config was validated.
    config: { ...discoveryConfig(config.discovery), enabled: true },
    bus,
    log: (message) => logger.info('discovery_status', { message }),
  });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const status = listener.status();
    listener.stop();
    clearTimeout(timer);
    logger.info('discovery_smoke_summary', {
      elapsedMs: Date.now() - startedAt,
      counts,
      status,
      chainLatencyVerified: false,
      note: 'Counts are observations only; zero events does not prove coverage. No backfill or public-RPC latency guarantee.',
    });
  };
  const timer = setTimeout(finish, duration);
  process.once('SIGINT', finish);
  process.once('SIGTERM', finish);
  listener.start();
}
