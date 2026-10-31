/** Bounded opt-in read-only smoke. No private key, signer or executor is loaded. */
import { createDiscoveryBus } from './bus.js';
import { discoveryConfig } from './config.js';
import { createDiscoveryListener } from './listener.js';

const argument = process.argv.slice(2);
const duration =
  argument.length === 2 && argument[0] === '--duration-ms' ? Number(argument[1]) : 30_000;
if (
  !Number.isInteger(duration) ||
  duration < 1_000 ||
  duration > 300_000 ||
  (argument.length !== 0 && (argument.length !== 2 || argument[0] !== '--duration-ms'))
) {
  throw new Error('Usage: smoke --duration-ms <1000..300000>');
}
const startedAt = Date.now();
const bus = createDiscoveryBus();
const counts: Record<string, number> = {};
bus.subscribe((event) => {
  counts[`${event.protocol}:${event.kind}`] = (counts[`${event.protocol}:${event.kind}`] ?? 0) + 1;
});
const listener = createDiscoveryListener({
  config: { ...discoveryConfig(), enabled: true },
  bus,
  log: (message) => {
    process.stdout.write(`${message}\n`);
  },
});
let finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  const status = listener.status();
  listener.stop();
  clearTimeout(timer);
  process.stdout.write(
    `${JSON.stringify({ elapsedMs: Date.now() - startedAt, counts, status, chainLatencyVerified: false, note: 'Counts are observations only; zero events does not prove coverage. No backfill or public-RPC latency guarantee.' }, null, 2)}\n`,
  );
};
const timer = setTimeout(finish, duration);
process.once('SIGINT', finish);
process.once('SIGTERM', finish);
listener.start();
