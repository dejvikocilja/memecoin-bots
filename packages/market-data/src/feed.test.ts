import { describe, expect, it } from 'vitest';
import { createMarketFeed } from './feed.js';
import { DexScreenerProvider } from './provider.js';
import type { SnapshotProvider } from './types.js';
import type { SnapshotStore, StoredCycle } from './store.js';

function mint(n: number) {
  let value = n + 1;
  let encoded = '';
  while (value > 0) {
    encoded = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[value % 58] + encoded;
    value = Math.floor(value / 58);
  }
  return '1'.repeat(31) + encoded;
}
function harness(count = 200) {
  let now = 60_000;
  const cycles: StoredCycle[] = [];
  const calls: number[] = [];
  const requestTimes: number[] = [];
  let notBefore: number | null = null;
  const store: SnapshotStore = {
    requestsNotBefore: async () => notBefore,
    deferRequests: async (until) => {
      notBefore = Math.max(notBefore ?? 0, until);
    },
    getRecentRequestTimes: async (since) => requestTimes.filter((time) => time >= since),
    recordRequest: async (time) => {
      requestTimes.push(time);
    },
    latestScheduledAt: async () => cycles.at(-1)?.scheduledAt ?? null,
    commitCycle: async (cycle) => {
      cycles.push(cycle);
      return true;
    },
    readTokenHistory: async () => [],
    close: async () => {},
  };
  const provider: SnapshotProvider = new DexScreenerProvider({
    clock: () => now,
    fetchImpl: async (input) => {
      calls.push(now);
      const tokens = String(input).split('/').at(-1)!.split(',');
      return Response.json(
        tokens.map((address) => ({
          chainId: 'solana',
          baseToken: { address },
          pairAddress: address,
          dexId: 'fixture',
          priceUsd: '0.125',
          liquidity: { usd: 200000 },
          volume: { m5: 500, h1: 6000 },
          txns: { m5: { buys: 10, sells: 5 }, h1: { buys: 100, sells: 60 } },
        })),
      );
    },
  });
  return {
    tokens: Array.from({ length: count }, (_, n) => mint(n)),
    cycles,
    calls,
    store,
    provider,
    clock: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('bounded market feed', () => {
  it('collects 200 tokens in seven evenly spaced requests per cycle, without a backlog', async () => {
    const h = harness();
    const feed = createMarketFeed(h);
    for (let i = 0; i < 120; i++) {
      const target = 60_000 + i * 30_000;
      h.advance(target - h.clock());
      const cycle = await feed.collectOnce();
      expect(cycle?.outcomes).toHaveLength(200);
      expect(cycle?.outcomes.every((outcome) => outcome.status === 'ok')).toBe(true);
      expect(h.clock() - target).toBe(6000);
    }
    expect(h.calls).toHaveLength(840);
    for (let i = 1; i < h.calls.length; i++)
      expect(h.calls[i]! - h.calls[i - 1]!).toBeGreaterThanOrEqual(1000);
    expect(h.cycles).toHaveLength(120);
  });
  it('does not recollect a committed checkpoint on restart and marks downtime', async () => {
    const h = harness();
    await createMarketFeed(h).collectOnce();
    expect(await createMarketFeed(h).collectOnce()).toBeNull();
    h.advance(90_000 - h.clock() + 60_000);
    const resumed = await createMarketFeed(h).collectOnce();
    expect(resumed?.gapFrom).toBe(90_000);
  });
  it('stops at 80% of the local request quota, persists unavailable records, and resumes after the window', async () => {
    const h = harness();
    const feed = createMarketFeed({ ...h, requestsPerMinute: 5 });
    const first = await feed.collectOnce();
    expect(h.calls).toHaveLength(4);
    expect(
      first?.outcomes.filter((o) => o.status === 'unavailable' && o.reason === 'quota_exhausted'),
    ).toHaveLength(80);
    h.advance(30_000 - h.clock() + 60_000);
    await feed.collectOnce();
    expect(h.calls).toHaveLength(4);
    h.advance(90_000 - h.clock() + 60_000);
    await feed.collectOnce();
    expect(h.calls).toHaveLength(8);
  });
  it('bounds retries and applies Retry-After globally without requesting beyond the deadline', async () => {
    const h = harness();
    h.provider.fetchSnapshots = async (tokens) => {
      h.calls.push(h.clock());
      return {
        receivedAt: h.clock(),
        outcomes: tokens.map((tokenAddress) => ({
          status: 'unavailable',
          tokenAddress,
          reason: 'rate_limited',
          retryAfterMs: 90_000,
        })),
      };
    };
    const cycle = await createMarketFeed(h).collectOnce();
    expect(h.calls).toHaveLength(1);
    expect(cycle?.outcomes).toHaveLength(200);
    expect(
      cycle?.outcomes.filter((o) => o.status === 'unavailable' && o.reason === 'deadline_exceeded'),
    ).toHaveLength(170);
  });
  it('retries a transient batch once and counts both attempts against quota', async () => {
    const h = harness(30);
    h.provider.fetchSnapshots = async (tokens) => {
      h.calls.push(h.clock());
      return {
        receivedAt: h.clock(),
        outcomes: tokens.map((tokenAddress) => ({
          status: 'unavailable',
          tokenAddress,
          reason: 'network_error',
        })),
      };
    };
    await createMarketFeed(h).collectOnce();
    expect(h.calls).toEqual([60_000, 61_000]);
  });
  it('discards responses arriving after the cycle deadline', async () => {
    const h = harness();
    const original = h.provider.fetchSnapshots.bind(h.provider);
    h.provider.fetchSnapshots = async (tokens) => {
      const result = await original(tokens);
      h.advance(31_000);
      return result;
    };
    const cycle = await createMarketFeed(h).collectOnce();
    expect(h.calls).toHaveLength(1);
    expect(
      cycle?.outcomes.every((o) => o.status === 'unavailable' && o.reason === 'deadline_exceeded'),
    ).toBe(true);
  });
  it('does not advance the checkpoint when persistence fails', async () => {
    const h = harness(1);
    h.store.commitCycle = async () => {
      throw new Error('disk unavailable');
    };
    await expect(createMarketFeed(h).collectOnce()).rejects.toThrow('disk unavailable');
    expect(await h.store.latestScheduledAt()).toBeNull();
  });
  it('keeps the final retry backoff across later batches, cycles and restarts', async () => {
    const h = harness();
    let requests = 0;
    h.provider.fetchSnapshots = async (tokens) => {
      h.calls.push(h.clock());
      requests++;
      return {
        receivedAt: h.clock(),
        outcomes: tokens.map((tokenAddress) => ({
          status: 'unavailable',
          tokenAddress,
          reason: 'rate_limited',
          retryAfterMs: requests === 1 ? 1000 : 300000,
        })),
      };
    };
    await createMarketFeed(h).collectOnce();
    expect(h.calls).toEqual([60000, 61000]);
    h.advance(90000 - h.clock());
    await createMarketFeed(h).collectOnce();
    expect(h.calls).toHaveLength(2);
  });
  it('honors a rate limit even if its response arrives after the data deadline', async () => {
    const h = harness(1);
    h.provider.fetchSnapshots = async (tokens) => {
      h.calls.push(h.clock());
      h.advance(31000);
      return {
        receivedAt: h.clock(),
        outcomes: tokens.map((tokenAddress) => ({
          status: 'unavailable',
          tokenAddress,
          reason: 'rate_limited',
          retryAfterMs: 300000,
        })),
      };
    };
    await createMarketFeed(h).collectOnce();
    h.advance(120000 - h.clock());
    await createMarketFeed(h).collectOnce();
    expect(h.calls).toHaveLength(1);
  });
  it('rejects concurrent collection and malformed provider batches', async () => {
    const h = harness(1);
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    h.provider.fetchSnapshots = async () => {
      await pending;
      return { receivedAt: h.clock(), outcomes: [] };
    };
    const feed = createMarketFeed(h);
    const first = feed.collectOnce();
    await expect(feed.collectOnce()).rejects.toThrow('already running');
    resolve();
    await expect(first).rejects.toThrow('invalid batch');
    expect(h.cycles).toHaveLength(0);
  });
  it('validates token count, timing and untrusted quota configuration', () => {
    const h = harness();
    expect(() => createMarketFeed({ ...h, tokens: [] })).toThrow();
    expect(() => createMarketFeed({ ...h, tokens: [h.tokens[0]!, h.tokens[0]!] })).toThrow();
    expect(() => createMarketFeed({ ...h, intervalMs: 1000 })).toThrow();
    expect(() => createMarketFeed({ ...h, requestsPerMinute: 301 })).toThrow();
  });
});
