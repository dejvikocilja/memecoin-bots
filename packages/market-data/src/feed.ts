import { isSolanaMint } from './provider.js';
import type { TokenOutcome, SnapshotProvider } from './types.js';
import type { SnapshotStore, StoredCycle } from './store.js';

export type FeedOutcome =
  | TokenOutcome
  | {
      status: 'unavailable';
      tokenAddress: string;
      reason: 'deadline_exceeded' | 'quota_exhausted' | 'collection_gap';
    };

export function validateFeedTokens(tokens: readonly string[]): void {
  if (
    tokens.length < 1 ||
    tokens.length > 200 ||
    new Set(tokens).size !== tokens.length ||
    !tokens.every(isSolanaMint)
  ) {
    throw new RangeError('Configure 1 to 200 distinct Solana token addresses.');
  }
}

export interface FeedOptions {
  tokens: readonly string[];
  provider: SnapshotProvider;
  store: SnapshotStore;
  intervalMs?: number;
  requestSpacingMs?: number;
  requestsPerMinute?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Single-flight, bounded polling. A slow cycle never creates a queue of old requests. */
export function createMarketFeed(options: FeedOptions) {
  const {
    provider,
    store,
    clock = Date.now,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    intervalMs = 30_000,
    requestSpacingMs = 1_000,
    requestsPerMinute = 60,
  } = options;
  const tokens = [...options.tokens];
  validateFeedTokens(tokens);
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 30_000 ||
    intervalMs > 3_600_000 ||
    !Number.isSafeInteger(requestSpacingMs) ||
    requestSpacingMs < 250 ||
    requestSpacingMs > intervalMs ||
    !Number.isSafeInteger(requestsPerMinute) ||
    requestsPerMinute < 1 ||
    requestsPerMinute > 300
  ) {
    throw new RangeError('Invalid market feed timing or quota.');
  }
  const quota = Math.floor(requestsPerMinute * 0.8);
  let requestTimes: number[] = [];
  let nextRequestAt = 0;
  let active = false;

  async function collectOnce(
    scheduledAt = Math.floor(clock() / intervalMs) * intervalMs,
  ): Promise<StoredCycle | null> {
    if (active) throw new Error('A collection cycle is already running.');
    if (
      !Number.isSafeInteger(scheduledAt) ||
      scheduledAt < 0 ||
      scheduledAt % intervalMs !== 0 ||
      scheduledAt > clock()
    ) {
      throw new RangeError('Invalid collection timestamp.');
    }
    active = true;
    try {
      const latest = await store.latestScheduledAt();
      if (latest !== null && scheduledAt <= latest) return null;
      requestTimes = await store.getRecentRequestTimes(Math.max(0, clock() - 60_000));
      // A restart cannot reset the limiter or an upstream backoff lease.
      nextRequestAt = Math.max(
        nextRequestAt,
        (await store.requestsNotBefore()) ?? 0,
        ...requestTimes.map((time) => time + requestSpacingMs),
      );
      const deadline = scheduledAt + intervalMs;
      const outcomes: FeedOutcome[] = [];
      for (let offset = 0; offset < tokens.length; offset += 30) {
        const batch = tokens.slice(offset, offset + 30);
        let batchOutcomes: readonly FeedOutcome[] | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (nextRequestAt > clock()) {
            // Never sleep beyond this cycle's deadline to satisfy a retry or quota.
            if (nextRequestAt >= deadline) break;
            await sleep(nextRequestAt - clock());
          }
          if (clock() >= deadline) break;
          requestTimes = requestTimes.filter((time) => time > clock() - 60_000);
          if (requestTimes.length >= quota) {
            batchOutcomes = batch.map((tokenAddress) => ({
              status: 'unavailable',
              tokenAddress,
              reason: 'quota_exhausted',
            }));
            break;
          }
          const started = clock();
          await store.recordRequest(started);
          requestTimes.push(started);
          nextRequestAt = started + requestSpacingMs;
          const result = await provider.fetchSnapshots(batch);
          const valid =
            result.outcomes.length === batch.length &&
            batch.every(
              (token) => result.outcomes.filter((item) => item.tokenAddress === token).length === 1,
            );
          if (!valid) throw new Error('Market provider returned an invalid batch.');
          batchOutcomes = result.outcomes;
          const backoff = Math.max(
            0,
            ...result.outcomes.map((item) =>
              item.status === 'unavailable' && item.reason === 'rate_limited'
                ? Math.max(1_000, item.retryAfterMs ?? 1_000)
                : 0,
            ),
          );
          if (backoff > 0) {
            nextRequestAt = Math.max(nextRequestAt, clock() + backoff);
            await store.deferRequests(nextRequestAt);
          }
          // Persist rate-limit metadata even when the response arrived too late to use.
          if (clock() >= deadline) break;
          const transient = result.outcomes.every(
            (item) =>
              item.status === 'unavailable' &&
              ['rate_limited', 'http_error', 'network_error', 'timeout'].includes(item.reason),
          );
          if (!transient || attempt === 1) break;
          const retryAfter = 1_000;
          // A provider's Retry-After applies globally, including subsequent batches.
          nextRequestAt = Math.max(nextRequestAt, clock() + retryAfter);
          if (nextRequestAt >= deadline) break;
        }
        outcomes.push(
          ...(clock() >= deadline || !batchOutcomes
            ? batch.map((tokenAddress) => ({
                status: 'unavailable' as const,
                tokenAddress,
                reason: 'deadline_exceeded' as const,
              }))
            : batchOutcomes),
        );
      }
      const cycle: StoredCycle = {
        id: `dexscreener-solana:${scheduledAt}`,
        scheduledAt,
        completedAt: clock(),
        outcomes,
        ...(latest !== null && scheduledAt > latest + intervalMs
          ? { gapFrom: latest + intervalMs }
          : {}),
      };
      await store.commitCycle(cycle);
      return cycle;
    } finally {
      active = false;
    }
  }

  async function run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const started = clock();
      await collectOnce(Math.floor(started / intervalMs) * intervalMs);
      if (signal.aborted) break;
      const next = (Math.floor(clock() / intervalMs) + 1) * intervalMs;
      // Small interruptible sleeps permit prompt shutdown without a backlog.
      while (!signal.aborted && clock() < next) await sleep(Math.min(250, next - clock()));
    }
  }
  return { collectOnce, run };
}
