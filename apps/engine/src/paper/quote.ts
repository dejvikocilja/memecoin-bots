import type {
  ApprovedOrderIntent,
  ChainContext,
  ExecutableQuote,
  QuoteEvidence,
  QuoteFee,
} from '@memebots/core';
import { PAPER_SOL_MINT } from '@memebots/core';
import type { Secret } from '@memebots/config';
import { integer, raw } from './model.js';

export interface QuoteRequest {
  readonly intent: ApprovedOrderIntent;
  readonly inputRaw: string;
}
export interface PaperQuoteProvider {
  quote(request: QuoteRequest): Promise<QuoteEvidence>;
  currentContext(): Promise<ChainContext | undefined>;
}
export function quoteMints(intent: ApprovedOrderIntent): [string, string] {
  return intent.side === 'buy'
    ? [PAPER_SOL_MINT, intent.tokenMint]
    : [intent.tokenMint, PAPER_SOL_MINT];
}
const mint = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v))
    throw new Error('INVALID_QUOTE');
  return v;
};
function object(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('INVALID_QUOTE');
  return v as Record<string, unknown>;
}
const optionalRaw = (v: unknown): string | null => (v === undefined ? null : raw(v).toString());
function estimate(v: unknown): string | null {
  return v === undefined ? null : integer(v, 0, Number.MAX_SAFE_INTEGER).toString();
}
/** Supported V2 subset: quote-only non-gasless Metis, sequential unsplit routes, net exchange amounts.
 * AMM breakdown and source age are UNKNOWN; local request age is explicitly MODEL, not chain freshness.
 */
export function normalizeJupiterQuote(
  value: unknown,
  request: QuoteRequest,
  requestStartedAt: number,
  receivedAt: number,
  local = false,
): ExecutableQuote {
  const r = object(value);
  const [inputMint, outputMint] = quoteMints(request.intent);
  if (
    r.transaction !== null ||
    r.errorCode !== undefined ||
    r.error !== undefined ||
    r.router !== 'metis' ||
    r.inputMint !== inputMint ||
    r.outputMint !== outputMint ||
    r.inAmount !== request.inputRaw ||
    r.swapMode !== 'ExactIn' ||
    r.slippageBps !== request.intent.maxSlippageBps ||
    r.gasless !== false ||
    r.taker !== null
  )
    throw new Error('QUOTE_MISMATCH_OR_UNSUPPORTED_ROUTE');
  if (
    [r.signatureFeePayer, r.prioritizationFeePayer, r.rentFeePayer].some(
      (v) => v !== undefined && v !== null,
    )
  )
    throw new Error('UNSUPPORTED_EXTRA_DEBIT_BEHAVIOR');
  if (request.intent.quoteRequirements.freshnessPolicy !== 'bounded_request_age')
    throw new Error('JUPITER_CHAIN_CONTEXT_UNAVAILABLE');
  raw(request.inputRaw, true);
  const outputRaw = raw(r.outAmount, true).toString();
  const providerMinimumOutputRaw = raw(r.otherAmountThreshold, true).toString();
  const policyMinimum =
    (BigInt(outputRaw) * BigInt(10000 - integer(request.intent.maxSlippageBps, 0, 5000)) + 9999n) /
    10000n;
  if (BigInt(providerMinimumOutputRaw) > BigInt(outputRaw)) throw new Error('INVALID_THRESHOLD');
  const minimumOutputRaw = (
    BigInt(providerMinimumOutputRaw) > policyMinimum
      ? BigInt(providerMinimumOutputRaw)
      : policyMinimum
  ).toString();
  if (!Array.isArray(r.routePlan) || r.routePlan.length < 1 || r.routePlan.length > 8)
    throw new Error('UNSUPPORTED_ROUTE');
  const route: string[] = [];
  let previousMint = inputMint;
  let previousAmount = request.inputRaw;
  const visited = new Set([inputMint]);
  for (const item of r.routePlan) {
    const step = object(item);
    const swap = object(step.swapInfo);
    const next = mint(swap.outputMint);
    if (
      step.bps !== 10000 ||
      swap.inputMint !== previousMint ||
      raw(swap.inAmount, true).toString() !== previousAmount ||
      visited.has(next)
    )
      throw new Error('UNSUPPORTED_SPLIT_OR_INCONSISTENT_ROUTE');
    route.push(mint(swap.ammKey));
    previousMint = next;
    previousAmount = raw(swap.outAmount, true).toString();
    visited.add(next);
  }
  if (previousMint !== outputMint || BigInt(previousAmount) < BigInt(outputRaw))
    throw new Error('INVALID_NET_AMOUNT');
  const platform = object(r.platformFee);
  const totalFeeBps = integer(r.feeBps, 0, 10000);
  const platformBps = integer(platform.feeBps, 0, 10000);
  const feeMint = mint(r.feeMint);
  if (
    feeMint !== mint(platform.feeMint) ||
    ![inputMint, outputMint].includes(feeMint) ||
    platformBps > totalFeeBps
  )
    throw new Error('INVALID_FEE_METADATA');
  const platformAmount = optionalRaw(platform.amount);
  if (
    platformAmount !== null &&
    BigInt(platformAmount) > BigInt(feeMint === inputMint ? request.inputRaw : previousAmount)
  )
    throw new Error('INVALID_PLATFORM_FEE');
  const fees: QuoteFee[] = [
    {
      kind: 'platform',
      mint: feeMint,
      amountRaw: platformAmount,
      rateBps: platformBps,
      inclusion: 'embedded',
    },
  ];
  const unknownFeeComponents = ['amm_fee_amounts', 'rent_account_creation'];
  if (platformAmount === null) unknownFeeComponents.push('platform_fee_amount');
  if (totalFeeBps !== platformBps) unknownFeeComponents.push('additional_embedded_fee_amounts');
  integer(requestStartedAt, 1, Number.MAX_SAFE_INTEGER);
  integer(receivedAt, requestStartedAt, requestStartedAt + 2000);
  let expiresAt = Math.min(
    requestStartedAt + Math.min(5000, request.intent.quoteRequirements.maxAgeMs),
    request.intent.expiresAt,
  );
  if (r.expireAt !== undefined) {
    if (typeof r.expireAt !== 'string') throw new Error('INVALID_PROVIDER_EXPIRY');
    const expiry = Date.parse(r.expireAt);
    if (!Number.isSafeInteger(expiry)) throw new Error('INVALID_PROVIDER_EXPIRY');
    expiresAt = Math.min(expiresAt, expiry);
  }
  if (receivedAt >= expiresAt) throw new Error('QUOTE_EXPIRED');
  let responseId: string | null = null;
  if (r.requestId !== undefined) {
    if (typeof r.requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(r.requestId))
      throw new Error('INVALID_RESPONSE_ID');
    responseId = r.requestId;
  }
  return Object.freeze({
    provider: local ? 'local_mock' : 'jupiter-v2',
    inputMint,
    outputMint,
    inputRaw: request.inputRaw,
    outputRaw,
    providerMinimumOutputRaw,
    minimumOutputRaw,
    slippageBps: request.intent.maxSlippageBps,
    contextSlot: null,
    contextBlockTimeMs: null,
    freshnessBasis: 'bounded_request_age_MODEL',
    requestStartedAt,
    receivedAt,
    expiresAt,
    responseId,
    route: Object.freeze(route),
    fees: Object.freeze(fees.map((f) => Object.freeze(f))),
    totalFeeBps,
    feeBreakdownCompleteness: 'partial',
    unknownFeeComponents: Object.freeze(unknownFeeComponents),
    transactionFeeEstimates: Object.freeze({
      networkLamports: estimate(r.signatureFeeLamports),
      priorityLamports: estimate(r.prioritizationFeeLamports),
      rentLamports: estimate(r.rentFeeLamports),
      scope: 'quote_only_no_taker',
    }),
  });
}
export function validateExecutableQuote(q: ExecutableQuote, request: QuoteRequest): void {
  const [inputMint, outputMint] = quoteMints(request.intent);
  if (
    !['jupiter-v2', 'local_mock'].includes(q.provider) ||
    q.inputMint !== inputMint ||
    q.outputMint !== outputMint ||
    q.inputRaw !== request.inputRaw ||
    q.slippageBps !== request.intent.maxSlippageBps
  )
    throw new Error('QUOTE_MISMATCH');
  raw(q.inputRaw, true);
  raw(q.outputRaw, true);
  raw(q.minimumOutputRaw, true);
  raw(q.providerMinimumOutputRaw, true);
  const policy = (BigInt(q.outputRaw) * BigInt(10000 - q.slippageBps) + 9999n) / 10000n;
  const effective =
    BigInt(q.providerMinimumOutputRaw) > policy ? BigInt(q.providerMinimumOutputRaw) : policy;
  if (BigInt(q.minimumOutputRaw) !== effective || effective > BigInt(q.outputRaw))
    throw new Error('INVALID_THRESHOLD');
  integer(q.requestStartedAt, 1, Number.MAX_SAFE_INTEGER);
  integer(q.receivedAt, q.requestStartedAt, q.requestStartedAt + 2000);
  integer(
    q.expiresAt,
    q.receivedAt + 1,
    Math.min(
      q.requestStartedAt + request.intent.quoteRequirements.maxAgeMs,
      request.intent.expiresAt,
    ),
  );
  if (q.freshnessBasis === 'bounded_request_age_MODEL') {
    if (
      request.intent.quoteRequirements.freshnessPolicy !== 'bounded_request_age' ||
      q.expiresAt > q.requestStartedAt + 5000 ||
      q.contextSlot !== null ||
      q.contextBlockTimeMs !== null ||
      q.feeBreakdownCompleteness !== 'partial'
    )
      throw new Error('INVALID_MODEL_FRESHNESS');
  } else if (q.freshnessBasis === 'chain_context') {
    if (request.intent.quoteRequirements.freshnessPolicy !== 'chain_context')
      throw new Error('FRESHNESS_POLICY_MISMATCH');
    integer(q.contextSlot, 1, Number.MAX_SAFE_INTEGER);
    integer(q.contextBlockTimeMs, 1, Number.MAX_SAFE_INTEGER);
  } else throw new Error('INVALID_FRESHNESS');
  if (
    !Array.isArray(q.route) ||
    q.route.length < 1 ||
    q.route.length > 8 ||
    !Array.isArray(q.fees) ||
    q.fees.length < 1 ||
    q.fees.length > 20 ||
    !q.fees.some((f) => f.kind === 'platform') ||
    !Array.isArray(q.unknownFeeComponents) ||
    q.unknownFeeComponents.length > 20
  )
    throw new Error('INVALID_FEE_METADATA');
  q.route.forEach(mint);
  for (const fee of q.fees) {
    mint(fee.mint);
    if (fee.amountRaw !== null) raw(fee.amountRaw);
    if (fee.rateBps !== null) integer(fee.rateBps, 0, 10000);
    if (!['swap', 'platform'].includes(fee.kind) || fee.inclusion !== 'embedded')
      throw new Error('INVALID_FEE_METADATA');
  }
  for (const unknown of q.unknownFeeComponents)
    if (!/^[a-z_]{1,80}$/.test(unknown)) throw new Error('INVALID_FEE_METADATA');
}
export function quoteIsFresh(
  q: ExecutableQuote,
  intent: ApprovedOrderIntent,
  current: ChainContext | undefined,
  now: number,
): boolean {
  if (
    !Number.isSafeInteger(now) ||
    now < q.requestStartedAt ||
    now < q.receivedAt ||
    now >= q.expiresAt ||
    now >= intent.expiresAt
  )
    return false;
  if (q.freshnessBasis === 'bounded_request_age_MODEL')
    return (
      intent.quoteRequirements.freshnessPolicy === 'bounded_request_age' &&
      now - q.requestStartedAt <= Math.min(5000, intent.quoteRequirements.maxAgeMs)
    );
  return (
    current !== undefined &&
    q.contextSlot !== null &&
    q.contextBlockTimeMs !== null &&
    Number.isSafeInteger(current.slot) &&
    Number.isSafeInteger(current.blockTimeMs) &&
    Number.isSafeInteger(current.observedAt) &&
    current.observedAt <= now &&
    now - current.observedAt <= 2000 &&
    current.slot >= q.contextSlot &&
    current.slot - q.contextSlot <= intent.quoteRequirements.maxSlotLag &&
    q.contextBlockTimeMs <= now &&
    now - q.contextBlockTimeMs <= intent.quoteRequirements.maxAgeMs &&
    current.blockTimeMs >= q.contextBlockTimeMs &&
    current.blockTimeMs <= now &&
    now - current.blockTimeMs <= intent.quoteRequirements.maxAgeMs
  );
}
/** Lossless numeric source tokens prevent rounded fractional/unsafe integer acceptance. */
export function parseQuoteJson(text: string): unknown {
  const parse = JSON.parse as (
    text: string,
    reviver: (key: string, value: unknown, context: { source?: string }) => unknown,
  ) => unknown;
  return parse(text, (key, value, context) => {
    if (
      typeof value === 'number' &&
      /^(contextSlot|slippageBps|bps|percent|feeBps|result|id|signatureFeeLamports|prioritizationFeeLamports|rentFeeLamports|decimals|maxSlippageBps|expiresInMs|maxAgeMs|maxSlotLag|minLatencyMs|maxLatencyMs|adverseSlippageBps|partialFillBps)$/.test(
        key,
      )
    ) {
      if (
        !context.source ||
        !/^(0|[1-9][0-9]*)$/.test(context.source) ||
        !Number.isSafeInteger(value) ||
        BigInt(context.source) !== BigInt(value)
      )
        throw new Error('INVALID_NUMERIC_TOKEN');
    }
    return value;
  });
}
export class QuoteRequestBudget {
  private times: number[] = [];
  take(now: number): void {
    this.times = this.times.filter((t) => now - t < 60000);
    if (this.times.length >= 20 || (this.times.length > 0 && now - this.times.at(-1)! < 2000))
      throw new Error('QUOTE_RATE_LIMIT');
    this.times.push(now);
  }
}
export class JupiterReadOnlyQuoteProvider implements PaperQuoteProvider {
  private readonly endpoint: string;
  private readonly local: boolean;
  private readonly budget: { take(now: number): void | Promise<void> };
  constructor(
    private readonly options: {
      apiKey?: Secret;
      fetch?: typeof fetch;
      clock?: () => number;
      monotonicClock?: () => number;
      budget?: { take(now: number): void | Promise<void> };
      localMockUrl?: string;
    },
  ) {
    this.endpoint = 'https://api.jup.ag/swap/v2/order';
    this.local = options.localMockUrl !== undefined;
    if (this.local) {
      const url = new URL(options.localMockUrl!);
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('INVALID_LOCAL_MOCK');
      this.endpoint = new URL('/swap/v2/order', url).toString();
    }
    this.budget = options.budget ?? new QuoteRequestBudget();
  }
  private now(): number {
    return integer((this.options.clock ?? Date.now)(), 1, Number.MAX_SAFE_INTEGER);
  }
  async currentContext(): Promise<undefined> {
    return undefined;
  }
  async quote(request: QuoteRequest): Promise<QuoteEvidence> {
    if (request.intent.quoteRequirements.freshnessPolicy !== 'bounded_request_age')
      return { status: 'unavailable', reason: 'JUPITER_CHAIN_CONTEXT_UNAVAILABLE' };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [inputMint, outputMint] = quoteMints(request.intent);
      raw(request.inputRaw, true);
      const url = new URL(this.endpoint);
      url.search = new URLSearchParams({
        inputMint,
        outputMint,
        amount: request.inputRaw,
        slippageBps: String(request.intent.maxSlippageBps),
        swapMode: 'ExactIn',
        excludeRouters: 'jupiterz,dflow,okx',
      }).toString();
      const headers: Record<string, string> = {};
      if (this.options.apiKey) headers['x-api-key'] = this.options.apiKey.reveal();
      await this.budget.take(this.now());
      const started = this.now();
      const monotonic = this.options.monotonicClock ?? (() => performance.now());
      const monotonicStart = monotonic();
      timer = setTimeout(() => controller.abort(), 2000);
      const response = await (this.options.fetch ?? fetch)(url.toString(), {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('QUOTE_HTTP_UNAVAILABLE');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('QUOTE_EMPTY');
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 262144) throw new Error('QUOTE_OVERSIZE');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (monotonic() - monotonicStart > 2000 || controller.signal.aborted)
        throw new Error('QUOTE_TIMEOUT');
      const quote = normalizeJupiterQuote(
        parseQuoteJson(Buffer.concat(chunks).toString('utf8')),
        request,
        started,
        this.now(),
        this.local,
      );
      return { status: 'available', quote };
    } catch {
      return { status: 'unavailable', reason: 'JUPITER_REQUIRED_QUOTE_EVIDENCE_UNAVAILABLE' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
export const unavailableSnapshotQuote: QuoteEvidence = Object.freeze({
  status: 'unavailable',
  reason: 'DEXSCREENER_SNAPSHOT_NOT_EXECUTABLE_QUOTE',
});
