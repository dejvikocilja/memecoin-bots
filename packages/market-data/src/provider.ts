import type {
  ProviderBatchResult,
  ProviderFailureReason,
  SnapshotProvider,
  TokenSnapshot,
  WindowMetrics,
} from './types.js';

// Official limits: https://docs.dexscreener.com/api/reference (tokens/v1).
// Shared rate limiting and retries belong to the poller, not to each request.
export const DEX_SCREENER_MAX_BATCH = 30;
export const DEX_SCREENER_REQUESTS_PER_MINUTE = 300;
const ENDPOINT = 'https://api.dexscreener.com/tokens/v1/solana/';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Solana mint/public-key syntax: base58 decoding must produce exactly 32 bytes. */
export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let bytes = 0;
  for (let remaining = decoded; remaining > 0n; remaining >>= 8n) bytes += 1;
  for (const character of value) {
    if (character !== '1') break;
    bytes += 1;
  }
  return bytes === 32;
}

/** Checks address syntax only; the data provider cannot prove an account is a mint. */
export const isSolanaMint = isSolanaAddress;

/** Receipt freshness only. The upstream quote timestamp is unavailable. */
export function isReceiptFresh(snapshot: TokenSnapshot, nowMs: number, maxAgeMs: number): boolean {
  return (
    Number.isSafeInteger(nowMs) &&
    Number.isSafeInteger(maxAgeMs) &&
    maxAgeMs >= 0 &&
    Number.isSafeInteger(snapshot.receivedAt) &&
    snapshot.receivedAt >= 0 &&
    snapshot.observedAt === snapshot.receivedAt &&
    snapshot.sourceTimestamp === null &&
    nowMs >= snapshot.receivedAt &&
    nowMs - snapshot.receivedAt <= maxAgeMs
  );
}

export interface DexScreenerProviderOptions {
  fetchImpl?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

type JsonObject = Record<string, unknown>;
type Candidate = Pick<
  TokenSnapshot,
  'tokenAddress' | 'pairAddress' | 'dexId' | 'priceUsd' | 'liquidityUsd'
> & {
  m5: WindowMetrics;
  h1: WindowMetrics;
};

class ResponseTooLarge extends Error {}
class InvalidResponse extends Error {}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Market data request timed out'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function optionalNumber(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || nonnegative(value);
}

function windowMetrics(pair: JsonObject, window: 'm5' | 'h1'): WindowMetrics | null {
  if (pair.volume !== undefined && !object(pair.volume)) return null;
  if (pair.txns !== undefined && !object(pair.txns)) return null;
  const volume = object(pair.volume) ? pair.volume[window] : undefined;
  const transactions = object(pair.txns) ? pair.txns[window] : undefined;
  if (!optionalNumber(volume)) return null;
  if (transactions !== undefined && !object(transactions)) return null;
  const buys = object(transactions) ? transactions.buys : undefined;
  const sells = object(transactions) ? transactions.sells : undefined;
  if (
    !optionalNumber(buys) ||
    !optionalNumber(sells) ||
    (typeof buys === 'number' && !Number.isSafeInteger(buys)) ||
    (typeof sells === 'number' && !Number.isSafeInteger(sells))
  ) {
    return null;
  }
  return { volumeUsd: volume ?? null, buyTransactions: buys ?? null, uniqueBuyers: null };
}

function candidate(value: unknown): Candidate | null {
  if (
    !object(value) ||
    value.chainId !== 'solana' ||
    !object(value.baseToken) ||
    !isSolanaAddress(value.baseToken.address) ||
    !isSolanaAddress(value.pairAddress) ||
    typeof value.dexId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(value.dexId) ||
    typeof value.priceUsd !== 'string' ||
    value.priceUsd.length > 128 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.priceUsd) ||
    !nonnegative(Number(value.priceUsd)) ||
    Number(value.priceUsd) === 0
  ) {
    return null;
  }
  if (value.liquidity !== undefined && value.liquidity !== null && !object(value.liquidity)) {
    return null;
  }
  const liquidity = object(value.liquidity) ? value.liquidity.usd : undefined;
  if (!optionalNumber(liquidity)) return null;
  const m5 = windowMetrics(value, 'm5');
  const h1 = windowMetrics(value, 'h1');
  if (!m5 || !h1) return null;
  return {
    tokenAddress: value.baseToken.address,
    pairAddress: value.pairAddress,
    dexId: value.dexId,
    priceUsd: value.priceUsd,
    liquidityUsd: liquidity ?? null,
    m5,
    h1,
  };
}

function compare(left: Candidate, right: Candidate): number {
  const liquidity = (right.liquidityUsd ?? -1) - (left.liquidityUsd ?? -1);
  if (liquidity !== 0) return liquidity;
  for (const key of ['pairAddress', 'dexId', 'priceUsd'] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  // Duplicate pair entries with inconsistent metrics still have a stable result.
  const leftMetrics = JSON.stringify([left.m5, left.h1]);
  const rightMetrics = JSON.stringify([right.m5, right.h1]);
  return leftMetrics < rightMetrics ? -1 : leftMetrics > rightMetrics ? 1 : 0;
}

function snapshot(pair: Candidate, receivedAt: number): TokenSnapshot {
  return {
    schemaVersion: 1,
    source: 'dexscreener',
    chain: 'solana',
    tokenAddress: pair.tokenAddress,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    observedAt: receivedAt,
    receivedAt,
    sourceTimestamp: null,
    priceUsd: pair.priceUsd,
    liquidityUsd: pair.liquidityUsd,
    windows: {
      m1: { volumeUsd: null, buyTransactions: null, uniqueBuyers: null },
      m5: pair.m5,
      h1: pair.h1,
    },
    quality: {
      sourceFreshness: 'unknown',
      timestampBasis: 'received_at',
      m1: 'not_provided',
      uniqueBuyers: 'not_provided',
      buyTransactions: 'transaction_count_not_unique_buyers',
      pairSelection: 'highest_known_liquidity_usd_then_pair_address',
    },
  };
}

async function readJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > limit) {
    void response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLarge();
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType) || response.body === null) {
    void response.body?.cancel().catch(() => undefined);
    throw new InvalidResponse();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ResponseTooLarge();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new InvalidResponse();
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function retryAfter(response: Response, nowMs: number): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - nowMs;
  // Preserve meaningful backoff across cycles; bound absurd upstream dates/delays.
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? Math.min(milliseconds, 24 * 60 * 60 * 1_000)
    : undefined;
}

export class DexScreenerProvider implements SnapshotProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: DexScreenerProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 60_000 ||
      !Number.isSafeInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1 ||
      this.maxResponseBytes > MAX_RESPONSE_BYTES
    ) {
      throw new RangeError('Invalid market data provider limits');
    }
  }

  async fetchSnapshots(tokenAddresses: readonly string[]): Promise<ProviderBatchResult> {
    const addresses = [...tokenAddresses];
    if (
      addresses.length < 1 ||
      addresses.length > DEX_SCREENER_MAX_BATCH ||
      new Set(addresses).size !== addresses.length ||
      !addresses.every(isSolanaAddress)
    ) {
      throw new RangeError('Expected 1 to 30 distinct Solana token addresses');
    }
    const fail = (reason: ProviderFailureReason, retryAfterMs?: number): ProviderBatchResult => ({
      receivedAt: this.now(),
      outcomes: addresses.map((tokenAddress) => ({
        status: 'unavailable',
        tokenAddress,
        reason,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      })),
    });
    const signal = AbortSignal.timeout(this.timeoutMs);
    let data: unknown;
    try {
      const response = await abortable(
        this.fetchImpl(`${ENDPOINT}${addresses.join(',')}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal,
        }),
        signal,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        return response.status === 429
          ? fail('rate_limited', retryAfter(response, this.now()))
          : fail('http_error');
      }
      data = await readJson(response, this.maxResponseBytes, signal);
    } catch (error) {
      if (signal.aborted) return fail('timeout');
      if (error instanceof ResponseTooLarge) return fail('response_too_large');
      if (error instanceof InvalidResponse) return fail('invalid_data');
      return fail('network_error');
    }
    if (!Array.isArray(data)) return fail('invalid_data');
    const receivedAt = this.now();
    const requested = new Set(addresses);
    const invalid = new Set<string>();
    const byToken = new Map<string, Candidate[]>();
    for (const raw of data) {
      const parsed = candidate(raw);
      if (parsed && requested.has(parsed.tokenAddress)) {
        const candidates = byToken.get(parsed.tokenAddress) ?? [];
        candidates.push(parsed);
        byToken.set(parsed.tokenAddress, candidates);
      } else if (
        object(raw) &&
        object(raw.baseToken) &&
        typeof raw.baseToken.address === 'string'
      ) {
        if (requested.has(raw.baseToken.address)) invalid.add(raw.baseToken.address);
      }
    }
    return {
      receivedAt,
      outcomes: addresses.map((tokenAddress) => {
        const pair = byToken.get(tokenAddress)?.sort(compare)[0];
        return pair
          ? { status: 'ok', tokenAddress, snapshot: snapshot(pair, receivedAt) }
          : {
              status: 'unavailable',
              tokenAddress,
              reason: invalid.has(tokenAddress) ? 'invalid_data' : 'missing',
            };
      }),
    };
  }

  private now(): number {
    let now: number;
    try {
      now = this.clock();
    } catch {
      throw new RangeError('Invalid market data clock');
    }
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('Invalid market data clock');
    return now;
  }
}
