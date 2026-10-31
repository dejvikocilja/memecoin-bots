import { describe, expect, it, vi } from 'vitest';

import { DexScreenerProvider, isReceiptFresh, isSolanaAddress } from './provider.js';
import type { TokenSnapshot } from './types.js';

const TOKEN = 'So11111111111111111111111111111111111111112';
const SECOND_TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAIR_A = '11111111111111111111111111111112';
const PAIR_B = '11111111111111111111111111111113';
const NOW = 1_793_470_000_000;

function pair(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    pairAddress: PAIR_A,
    baseToken: { address: TOKEN },
    quoteToken: { address: SECOND_TOKEN },
    priceUsd: '0.000123456789',
    liquidity: { usd: 100_000 },
    txns: { m5: { buys: 12, sells: 10 }, h1: { buys: 30, sells: 28 } },
    volume: { m5: 200, h1: 1500 },
    pairCreatedAt: NOW - 86_400_000,
    ...overrides,
  };
}

function mockFetch(body: unknown, options: ResponseInit = {}): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        ...options,
        headers: { 'content-type': 'application/json', ...options.headers },
      }),
  );
}

async function oneSnapshot(body: unknown): Promise<TokenSnapshot> {
  const result = await new DexScreenerProvider({
    fetchImpl: mockFetch(body),
    clock: () => NOW,
  }).fetchSnapshots([TOKEN]);
  const outcome = result.outcomes[0];
  if (outcome?.status !== 'ok') throw new Error('Expected fixture snapshot');
  return outcome.snapshot;
}

describe('DEX Screener provider', () => {
  it('uses the read-only batched endpoint and keeps unsupported metrics explicit', async () => {
    const fetchImpl = mockFetch([pair()]);
    const provider = new DexScreenerProvider({ fetchImpl, clock: () => NOW });
    const result = await provider.fetchSnapshots([TOKEN, SECOND_TOKEN]);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.dexscreener.com/tokens/v1/solana/${TOKEN},${SECOND_TOKEN}`,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[1]).toEqual({
      status: 'unavailable',
      tokenAddress: SECOND_TOKEN,
      reason: 'missing',
    });
    const snapshot = result.outcomes[0]?.status === 'ok' ? result.outcomes[0].snapshot : null;
    expect(snapshot).toMatchObject({
      observedAt: NOW,
      receivedAt: NOW,
      sourceTimestamp: null,
      priceUsd: '0.000123456789',
      windows: {
        m1: { volumeUsd: null, buyTransactions: null, uniqueBuyers: null },
        m5: { volumeUsd: 200, buyTransactions: 12, uniqueBuyers: null },
        h1: { volumeUsd: 1500, buyTransactions: 30, uniqueBuyers: null },
      },
      quality: {
        sourceFreshness: 'unknown',
        timestampBasis: 'received_at',
        uniqueBuyers: 'not_provided',
      },
    });
  });

  it('chooses greatest known USD liquidity with a stable address tie-break', async () => {
    const entries = [
      pair({ pairAddress: PAIR_B, liquidity: { usd: 500_000 }, priceUsd: '2' }),
      pair({ liquidity: { usd: 500_000 }, priceUsd: '1' }),
      pair({ liquidity: { usd: 1 }, priceUsd: '3' }),
      pair({ liquidity: null, priceUsd: '4' }),
    ];
    const first = await oneSnapshot(entries);
    const reversed = await oneSnapshot([...entries].reverse());
    expect(first.pairAddress).toBe(PAIR_A);
    expect(first.priceUsd).toBe('1');
    expect(first).toEqual(reversed);
  });

  it('does not borrow a price from another chain or from a quote-token match', async () => {
    const result = await new DexScreenerProvider({
      fetchImpl: mockFetch([
        pair({ chainId: 'ethereum' }),
        pair({ baseToken: { address: SECOND_TOKEN }, quoteToken: { address: TOKEN } }),
      ]),
      clock: () => NOW,
    }).fetchSnapshots([TOKEN]);
    expect(result.outcomes).toEqual([
      { status: 'unavailable', tokenAddress: TOKEN, reason: 'invalid_data' },
    ]);
  });

  it('keeps absent optional values null, including a real zero', async () => {
    const snapshot = await oneSnapshot([
      pair({ liquidity: null, txns: { m5: { buys: 0 } }, volume: { m5: 0 } }),
    ]);
    expect(snapshot.liquidityUsd).toBeNull();
    expect(snapshot.windows.m5).toEqual({ volumeUsd: 0, buyTransactions: 0, uniqueBuyers: null });
    expect(snapshot.windows.h1).toEqual({
      volumeUsd: null,
      buyTransactions: null,
      uniqueBuyers: null,
    });
  });

  it.each([
    { priceUsd: 'NaN' },
    { priceUsd: 'Infinity' },
    { priceUsd: '-0.1' },
    { priceUsd: ' 1 ' },
    { priceUsd: '0' },
    { priceUsd: '1e999' },
    { liquidity: { usd: -1 } },
    { volume: { m5: -1 } },
    { volume: { h1: '12' } },
    { txns: { m5: { buys: 1.5 } } },
    { txns: { h1: { buys: Number.MAX_SAFE_INTEGER + 1 } } },
    { pairAddress: 'not-a-public-key' },
    { dexId: 'invalid\nlog entry' },
  ])('rejects malformed values rather than publishing a quote: %j', async (overrides) => {
    const result = await new DexScreenerProvider({
      fetchImpl: mockFetch([pair(overrides)]),
      clock: () => NOW,
    }).fetchSnapshots([TOKEN]);
    expect(result.outcomes[0]).toEqual({
      status: 'unavailable',
      tokenAddress: TOKEN,
      reason: 'invalid_data',
    });
  });

  it('rejects nonfinite numeric fields from raw JSON exponent overflow', async () => {
    const body = JSON.stringify([pair()]).replace('100000', '1e999');
    const provider = new DexScreenerProvider({
      fetchImpl: vi.fn(
        async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
      ),
      clock: () => NOW,
    });
    expect((await provider.fetchSnapshots([TOKEN])).outcomes[0]).toMatchObject({
      reason: 'invalid_data',
    });
  });

  it('does not invent one-minute metrics or buyers even if similarly named extras appear', async () => {
    const snapshot = await oneSnapshot([
      pair({
        volume: { m1: 10, m5: 200, h1: 1500 },
        uniqueBuyers: { m1: 1, m5: 10, h1: 20 },
        sourceTimestamp: NOW,
      }),
    ]);
    expect(snapshot.windows.m1).toEqual({
      volumeUsd: null,
      buyTransactions: null,
      uniqueBuyers: null,
    });
    expect(snapshot.windows.m5.uniqueBuyers).toBeNull();
    expect(snapshot.sourceTimestamp).toBeNull();
  });

  it.each([{}, { pairs: [] }, null, 'bad'])(
    'treats changed response envelopes as invalid',
    async (body) => {
      const provider = new DexScreenerProvider({ fetchImpl: mockFetch(body), clock: () => NOW });
      expect((await provider.fetchSnapshots([TOKEN])).outcomes[0]).toMatchObject({
        reason: 'invalid_data',
      });
    },
  );

  it('returns a missing outcome for every requested mint when no pair is returned', async () => {
    const provider = new DexScreenerProvider({ fetchImpl: mockFetch([]), clock: () => NOW });
    expect((await provider.fetchSnapshots([TOKEN, SECOND_TOKEN])).outcomes).toEqual([
      { status: 'unavailable', tokenAddress: TOKEN, reason: 'missing' },
      { status: 'unavailable', tokenAddress: SECOND_TOKEN, reason: 'missing' },
    ]);
  });

  it('reports 429 and a bounded retry hint without retrying inside the provider', async () => {
    const fetchImpl = mockFetch({}, { status: 429, headers: { 'retry-after': '300' } });
    const provider = new DexScreenerProvider({ fetchImpl, clock: () => NOW });
    expect((await provider.fetchSnapshots([TOKEN])).outcomes[0]).toEqual({
      status: 'unavailable',
      tokenAddress: TOKEN,
      reason: 'rate_limited',
      retryAfterMs: 300_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bounds absurd retry hints at 24 hours', async () => {
    const provider = new DexScreenerProvider({
      fetchImpl: mockFetch({}, { status: 429, headers: { 'retry-after': '999999999' } }),
      clock: () => NOW,
    });
    expect((await provider.fetchSnapshots([TOKEN])).outcomes[0]).toMatchObject({
      retryAfterMs: 24 * 60 * 60 * 1_000,
    });
  });

  it('accepts an HTTP-date retry hint and ignores malformed hints', async () => {
    const good = new DexScreenerProvider({
      fetchImpl: mockFetch(
        {},
        { status: 429, headers: { 'retry-after': new Date(NOW + 5_000).toUTCString() } },
      ),
      clock: () => NOW,
    });
    expect((await good.fetchSnapshots([TOKEN])).outcomes[0]).toMatchObject({ retryAfterMs: 5_000 });
    const bad = new DexScreenerProvider({
      fetchImpl: mockFetch({}, { status: 429, headers: { 'retry-after': '-1' } }),
      clock: () => NOW,
    });
    expect((await bad.fetchSnapshots([TOKEN])).outcomes[0]).not.toHaveProperty('retryAfterMs');
  });

  it('never returns raw upstream error content', async () => {
    const provider = new DexScreenerProvider({
      fetchImpl: mockFetch({ message: 'private upstream URL or credential' }, { status: 503 }),
      clock: () => NOW,
    });
    const result = await provider.fetchSnapshots([TOKEN]);
    expect(result.outcomes[0]).toMatchObject({ reason: 'http_error' });
    expect(JSON.stringify(result)).not.toContain('private upstream');
    const network = new DexScreenerProvider({
      fetchImpl: vi.fn(async () => {
        throw new Error('private transport details');
      }),
      clock: () => NOW,
    });
    expect((await network.fetchSnapshots([TOKEN])).outcomes[0]).toMatchObject({
      reason: 'network_error',
    });
  });

  it('bounds streamed response bytes even without content-length', async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('['.repeat(101)));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const provider = new DexScreenerProvider({
      fetchImpl,
      maxResponseBytes: 100,
      clock: () => NOW,
    });
    expect((await provider.fetchSnapshots([TOKEN])).outcomes[0]).toMatchObject({
      reason: 'response_too_large',
    });
  });

  it('rejects oversized advertised responses before reading them', async () => {
    const provider = new DexScreenerProvider({
      fetchImpl: mockFetch([], { headers: { 'content-length': '1000' } }),
      maxResponseBytes: 100,
      clock: () => NOW,
    });
    expect((await provider.fetchSnapshots([TOKEN])).outcomes[0]).toMatchObject({
      reason: 'response_too_large',
    });
  });

  it('turns aborted requests into an explicit timeout gap', async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('sensitive transport error')),
            { once: true },
          );
        }),
    );
    const provider = new DexScreenerProvider({ fetchImpl, timeoutMs: 5, clock: () => NOW });
    expect((await provider.fetchSnapshots([TOKEN])).outcomes[0]).toMatchObject({
      reason: 'timeout',
    });
  });

  it('times out a stalled body stream after receiving HTTP headers', async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        new Response(new ReadableStream(), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const provider = new DexScreenerProvider({ fetchImpl, timeoutMs: 5, clock: () => NOW });
    expect((await provider.fetchSnapshots([TOKEN])).outcomes[0]).toMatchObject({
      reason: 'timeout',
    });
  });

  it('rejects malformed JSON and UTF-8 without leaking the raw body', async () => {
    for (const body of ['private non-JSON body', new Uint8Array([0xff])]) {
      const provider = new DexScreenerProvider({
        fetchImpl: vi.fn(
          async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
        ),
        clock: () => NOW,
      });
      const result = await provider.fetchSnapshots([TOKEN]);
      expect(result.outcomes[0]).toMatchObject({ reason: 'invalid_data' });
      expect(JSON.stringify(result)).not.toContain('private');
    }
  });

  it('rejects bad inputs before sending any request', async () => {
    const fetchImpl = mockFetch([]);
    const provider = new DexScreenerProvider({ fetchImpl });
    await expect(provider.fetchSnapshots([])).rejects.toThrow('1 to 30');
    await expect(provider.fetchSnapshots([TOKEN, TOKEN])).rejects.toThrow('1 to 30');
    await expect(provider.fetchSnapshots(['invalid/address'])).rejects.toThrow('1 to 30');
    await expect(provider.fetchSnapshots(Array<string>(31).fill(TOKEN))).rejects.toThrow('1 to 30');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isSolanaAddress('1'.repeat(44))).toBe(false);
    expect(isSolanaAddress(TOKEN)).toBe(true);
  });
});

describe('receipt freshness', () => {
  it('expires receipts and fails closed for future and inconsistent timestamps', async () => {
    const snapshot = await oneSnapshot([pair()]);
    expect(isReceiptFresh(snapshot, NOW, 30_000)).toBe(true);
    expect(isReceiptFresh(snapshot, NOW + 30_001, 30_000)).toBe(false);
    expect(isReceiptFresh(snapshot, NOW - 1, 30_000)).toBe(false);
    expect(isReceiptFresh({ ...snapshot, observedAt: NOW - 1 }, NOW, 30_000)).toBe(false);
    expect(isReceiptFresh(snapshot, Number.NaN, 30_000)).toBe(false);
    expect(isReceiptFresh(snapshot, NOW, -1)).toBe(false);
    expect(snapshot.quality.sourceFreshness).toBe('unknown');
  });
});
