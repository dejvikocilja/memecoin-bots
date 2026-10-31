import type { MarketDiscoveryEvent } from '@memebots/core';

import type { DiscoveryBus } from './bus.js';
import type { DiscoveryConfig } from './config.js';
import { decodeLogs, decodeTransaction, needsTransaction, PROGRAMS } from './decoder.js';
import { getTransaction, RpcRequestError } from './rpc.js';
import type { RpcTransaction } from './rpc.js';
import { DiscoveryTransport } from './transport.js';
import type { LogNotification, SocketLike, TransportState } from './transport.js';

export interface DiscoveryStatus {
  readonly connection: TransportState;
  readonly degraded: boolean;
  /** A disconnect can miss events: this listener does not backfill. */
  readonly gapDetected: boolean;
  readonly notifications: number;
  readonly published: number;
  readonly duplicates: number;
  readonly queueDepth: number;
  readonly inFlight: number;
  readonly dropped: number;
  readonly exhausted: number;
  readonly decodeFailures: number;
  readonly unrecognized: number;
  readonly reconnects: number;
  readonly maxNotificationToPublishMs: number | null;
}
export interface DiscoveryListener {
  start(): void;
  stop(): void;
  status(): DiscoveryStatus;
}
interface Job {
  readonly notification: LogNotification;
  readonly directEvents: number;
  attempts: number;
  availableAt: number;
}
interface ListenerOptions {
  readonly config: DiscoveryConfig;
  readonly bus: DiscoveryBus;
  readonly log: (message: string) => void;
  readonly createSocket?: (url: string) => SocketLike;
  readonly readTransaction?: (
    url: string,
    signature: string,
    signal: AbortSignal,
  ) => Promise<RpcTransaction | null>;
  readonly random?: () => number;
}

export function createDiscoveryListener(options: ListenerOptions): DiscoveryListener {
  const { config, bus, log } = options;
  const readTransaction = options.readTransaction ?? getTransaction;
  const random = options.random ?? Math.random;
  const seenEvents = new Map<string, number>();
  const seenSignatures = new Map<string, number>();
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  let running = false;
  let controller = new AbortController();
  let ticker: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let nextRequestAt = 0;
  let connection: TransportState = 'stopped';
  let inFlight = 0;
  let gapDetected = false;
  let notifications = 0;
  let published = 0;
  let duplicates = 0;
  let dropped = 0;
  let exhausted = 0;
  let decodeFailures = 0;
  let unrecognized = 0;
  let reconnects = 0;
  let maxNotificationToPublishMs: number | null = null;

  const remember = (map: Map<string, number>, key: string) => {
    map.delete(key);
    map.set(key, Date.now());
    while (map.size > config.dedupLimit) map.delete(map.keys().next().value!);
  };
  const contains = (map: Map<string, number>, key: string) => {
    const time = map.get(key);
    if (time === undefined) return false;
    if (Date.now() - time >= config.dedupTtlMs) {
      map.delete(key);
      return false;
    }
    return true;
  };
  const publish = (events: readonly MarketDiscoveryEvent[], receivedAt: number) => {
    for (const event of events) {
      if (contains(seenEvents, event.id)) {
        duplicates++;
        continue;
      }
      remember(seenEvents, event.id);
      published++;
      maxNotificationToPublishMs = Math.max(
        maxNotificationToPublishMs ?? 0,
        Date.now() - receivedAt,
      );
      bus.publish(event);
    }
  };
  const finish = (job: Job) => {
    jobs.delete(job.notification.signature);
    remember(seenSignatures, job.notification.signature);
  };
  const drain = () => {
    if (!running || inFlight >= config.concurrency || Date.now() < nextRequestAt) return;
    const index = queue.findIndex((job) => job.availableAt <= Date.now());
    if (index < 0) return;
    const job = queue.splice(index, 1)[0]!;
    const currentGeneration = generation;
    inFlight++;
    nextRequestAt = Date.now() + Math.ceil(1_000 / config.requestsPerSecond);
    job.attempts++;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.rpcTimeoutMs)]);
    void readTransaction(config.rpcUrl, job.notification.signature, signal)
      .then((transaction) => {
        if (!running || generation !== currentGeneration) return;
        if (transaction === null) throw new Error('Transaction not indexed yet');
        // A provider returning the wrong slot is not usable provenance.
        if (transaction.slot !== job.notification.slot)
          throw new Error('Transaction slot mismatch');
        if (transaction.meta.err !== null) {
          finish(job);
          return;
        }
        try {
          const events = decodeTransaction(transaction, job.notification, () => {
            decodeFailures++;
          });
          if (!events.length && job.directEvents === 0) unrecognized++;
          publish(events, job.notification.receivedAt ?? Date.now());
          finish(job);
        } catch {
          decodeFailures++;
          finish(job);
        }
      })
      .catch((error: unknown) => {
        if (!running || generation !== currentGeneration) return;
        if (error instanceof RpcRequestError)
          nextRequestAt = Math.max(nextRequestAt, Date.now() + error.retryAfterMs);
        if (job.attempts <= config.retryLimit) {
          job.availableAt =
            Date.now() +
            Math.max(
              error instanceof RpcRequestError ? error.retryAfterMs : 0,
              Math.min(8_000, 500 * 2 ** (job.attempts - 1)) * (0.75 + random() * 0.5),
            );
          queue.push(job);
        } else {
          exhausted++;
          finish(job);
        }
      })
      .finally(() => {
        if (generation !== currentGeneration) return;
        inFlight--;
        drain();
      });
  };
  const transport = new DiscoveryTransport(
    config,
    PROGRAMS.map((program) => program.id),
    (notification) => {
      if (!running) return;
      notifications++;
      let directEvents = 0;
      try {
        const events = decodeLogs(notification, () => {
          decodeFailures++;
        });
        directEvents = events.length;
        publish(events, notification.receivedAt ?? Date.now());
      } catch {
        decodeFailures++;
      }
      if (!needsTransaction(notification.logs)) return;
      if (jobs.has(notification.signature) || contains(seenSignatures, notification.signature)) {
        duplicates++;
        return;
      }
      if (jobs.size >= config.queueLimit) {
        dropped++;
        return;
      }
      const job: Job = { notification, directEvents, attempts: 0, availableAt: Date.now() };
      jobs.set(notification.signature, job);
      queue.push(job);
      drain();
    },
    (state) => {
      if (state === 'reconnecting' && connection !== 'reconnecting') {
        gapDetected = true;
        reconnects++;
        // Only state transitions are logged, never raw endpoints or provider errors.
        log('discovery reconnecting; observations may be missing during the gap');
      }
      if (state === 'ready' && connection !== 'ready')
        log('discovery subscriptions ready (confirmed)');
      connection = state;
    },
    options.createSocket,
    random,
  );

  return {
    start() {
      if (running || !config.enabled) return;
      running = true;
      generation++;
      controller = new AbortController();
      ticker = setInterval(
        drain,
        Math.max(10, Math.min(100, Math.ceil(1_000 / config.requestsPerSecond))),
      );
      transport.start();
    },
    stop() {
      if (!running) return;
      running = false;
      generation++;
      controller.abort();
      clearInterval(ticker);
      queue.length = 0;
      jobs.clear();
      inFlight = 0;
      nextRequestAt = 0;
      transport.stop();
    },
    status() {
      return {
        connection,
        degraded:
          gapDetected || dropped > 0 || exhausted > 0 || decodeFailures > 0 || unrecognized > 0,
        gapDetected,
        notifications,
        published,
        duplicates,
        queueDepth: queue.length,
        inFlight,
        dropped,
        exhausted,
        decodeFailures,
        unrecognized,
        reconnects,
        maxNotificationToPublishMs,
      };
    },
  };
}
