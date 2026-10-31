import { describe, expect, it } from 'vitest';
import type { ApprovedOrderIntent } from '@memebots/core';
import {
  JupiterReadOnlyQuoteProvider,
  normalizeJupiterQuote,
  parseQuoteJson,
  QuoteRequestBudget,
  quoteIsFresh,
  unavailableSnapshotQuote,
  validateExecutableQuote,
} from './quote.js';
import captured from './fixtures/jupiter-v2-quote-only.json' with { type: 'json' };
const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const sol = 'So11111111111111111111111111111111111111112';
const intent = {
  side: 'buy',
  tokenMint: mint,
  maxSlippageBps: 300,
  expiresAt: 2000000,
  quoteRequirements: {
    freshnessPolicy: 'bounded_request_age',
    maxAgeMs: 5000,
    maxSlotLag: 20,
    fullyObservedCosts: false,
  },
} as ApprovedOrderIntent;
const request = { intent, inputRaw: '10000' };
function response() {
  return {
    router: 'metis',
    transaction: null,
    gasless: false,
    taker: null,
    inputMint: sol,
    outputMint: mint,
    inAmount: '10000',
    outAmount: '20000',
    otherAmountThreshold: '19400',
    swapMode: 'ExactIn',
    slippageBps: 300,
    feeBps: 10,
    feeMint: sol,
    platformFee: { feeBps: 10, feeMint: sol },
    routePlan: [
      {
        bps: 10000,
        swapInfo: {
          ammKey: mint,
          inputMint: sol,
          outputMint: mint,
          inAmount: '10000',
          outAmount: '20000',
        },
      },
    ],
  };
}
describe('read-only V2 quote and explicit MODEL evidence', () => {
  it('accepts genuine captured two-hop schema without inventing AMM fees/source slots', () => {
    const realRequest = {
      intent: { ...intent, tokenMint: captured.response.outputMint, maxSlippageBps: 100 },
      inputRaw: '10000000',
    };
    const q = normalizeJupiterQuote(captured.response, realRequest, 1000000, 1000100);
    validateExecutableQuote(q, realRequest);
    expect(q.route).toHaveLength(2);
    expect(q.contextSlot).toBe(null);
    expect(q.contextBlockTimeMs).toBe(null);
    expect(q.freshnessBasis).toBe('bounded_request_age_MODEL');
    expect(q.fees[0]).toEqual({
      kind: 'platform',
      mint: sol,
      amountRaw: null,
      rateBps: 2,
      inclusion: 'embedded',
    });
    expect(q.feeBreakdownCompleteness).toBe('partial');
    expect(q.unknownFeeComponents).toContain('amm_fee_amounts');
    expect(q.transactionFeeEstimates.scope).toBe('quote_only_no_taker');
  });
  it('records optional fee amounts embedded without subtracting again; different total/platform fee rates remain explicit', () => {
    const r = {
      ...response(),
      feeBps: 20,
      platformFee: { ...response().platformFee, amount: '10' },
    };
    const q = normalizeJupiterQuote(r, request, 1000000, 1000100);
    expect(q.outputRaw).toBe('20000');
    expect(q.fees[0]!.amountRaw).toBe('10');
    expect(q.totalFeeBps).toBe(20);
    expect(q.unknownFeeComponents).toContain('additional_embedded_fee_amounts');
  });
  it.each([
    'inputMint',
    'inAmount',
    'outAmount',
    'otherAmountThreshold',
    'platformFee',
    'routePlan',
    'gasless',
    'taker',
  ])('rejects missing mandatory %s', (field) => {
    const r: Record<string, unknown> = response();
    delete r[field];
    expect(() => normalizeJupiterQuote(r, request, 1000000, 1000100)).toThrow();
  });
  it('rejects mismatched amount, unsupported route/gasless, invalid optional fees and extra debit payers', () => {
    const a = response();
    a.inAmount = '9999';
    expect(() => normalizeJupiterQuote(a, request, 1000000, 1000100)).toThrow();
    const b = response();
    b.router = 'jupiterz';
    expect(() => normalizeJupiterQuote(b, request, 1000000, 1000100)).toThrow();
    expect(() =>
      normalizeJupiterQuote({ ...response(), gasless: true }, request, 1000000, 1000100),
    ).toThrow();
    expect(() =>
      normalizeJupiterQuote({ ...response(), signatureFeePayer: mint }, request, 1000000, 1000100),
    ).toThrow();
    expect(() =>
      normalizeJupiterQuote(
        { ...response(), platformFee: { ...response().platformFee, amount: '-1' } },
        request,
        1000000,
        1000100,
      ),
    ).toThrow();
  });
  it('retains provider floor threshold and clamps effective minimum to approved ceil; zero slippage and equality valid', () => {
    const r = {
      ...response(),
      outAmount: '101',
      otherAmountThreshold: '97',
      routePlan: [
        { bps: 10000, swapInfo: { ...response().routePlan[0]!.swapInfo, outAmount: '101' } },
      ],
    };
    const q = normalizeJupiterQuote(r, request, 1000000, 1000000);
    expect(q.providerMinimumOutputRaw).toBe('97');
    expect(q.minimumOutputRaw).toBe('98');
    const zeroRequest = { intent: { ...intent, maxSlippageBps: 0 }, inputRaw: '10000' };
    const same = normalizeJupiterQuote(
      { ...response(), slippageBps: 0, otherAmountThreshold: '20000' },
      zeroRequest,
      1000000,
      1000000,
    );
    expect(same.minimumOutputRaw).toBe(same.outputRaw);
    validateExecutableQuote(same, zeroRequest);
  });
  it('strict chain policy remains unavailable, never relabeled receipt or fabricated slot', async () => {
    const strict = {
      intent: {
        ...intent,
        quoteRequirements: {
          ...intent.quoteRequirements,
          freshnessPolicy: 'chain_context' as const,
        },
      },
      inputRaw: '10000',
    };
    expect(() => normalizeJupiterQuote(response(), strict, 1000000, 1000100)).toThrow(
      'JUPITER_CHAIN_CONTEXT_UNAVAILABLE',
    );
    let calls = 0;
    const provider = new JupiterReadOnlyQuoteProvider({
      fetch: async () => {
        calls++;
        return new Response();
      },
    });
    expect(await provider.quote(strict)).toEqual({
      status: 'unavailable',
      reason: 'JUPITER_CHAIN_CONTEXT_UNAVAILABLE',
    });
    expect(calls).toBe(0);
  });
  it('expires from REQUEST START after latency/slow IO and rejects backward/future UTC; source time remains unknown', () => {
    const q = normalizeJupiterQuote(response(), request, 1000000, 1001000);
    expect(q.expiresAt).toBe(1005000);
    expect(quoteIsFresh(q, intent, undefined, 1004999)).toBe(true);
    for (const now of [999999, 1000500, 1005000])
      expect(quoteIsFresh(q, intent, undefined, now)).toBe(false);
    expect(() => normalizeJupiterQuote(response(), request, 1000000, 1002001)).toThrow();
    expect(() =>
      normalizeJupiterQuote(
        { ...response(), expireAt: new Date(1000100).toISOString() },
        request,
        1000000,
        1000100,
      ),
    ).toThrow();
  });
  it('does not accept lossy JSON integer tokens', () => {
    for (const token of ['9007199254740990.75', '9007199254740993', '1e2', '1.0'])
      expect(() => parseQuoteJson(`{"slippageBps":${token}}`)).toThrow();
    expect(parseQuoteJson('{"feeBps":100,"priceImpact":0.1}')).toEqual({
      feeBps: 100,
      priceImpact: 0.1,
    });
  });
  it('retains unavailable BOT7 snapshot', () => {
    expect(unavailableSnapshotQuote.status).toBe('unavailable');
  });
  it('bounds request budget to20rpm and >=2seconds, only GET order without taker or RPC', async () => {
    const budget = new QuoteRequestBudget();
    for (let i = 0; i < 20; i++) budget.take(1000 + i * 2000);
    expect(() => budget.take(41000)).toThrow();
    expect(() => budget.take(61000)).not.toThrow();
    expect(() => budget.take(62000)).toThrow();
    const seen: string[] = [];
    const provider = new JupiterReadOnlyQuoteProvider({
      clock: () => 1000000,
      fetch: async (url, init) => {
        seen.push(String(url));
        expect(init?.method).toBe('GET');
        return new Response(JSON.stringify(response()));
      },
    });
    expect((await provider.quote(request)).status).toBe('available');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('excludeRouters=jupiterz%2Cdflow%2Cokx');
    expect(seen[0]).not.toContain('taker');
    expect(seen[0]).not.toContain('/execute');
  });
  it('redacts malformed/oversize/429/errors and does not retry', async () => {
    for (const res of [
      new Response('credential raw bad'),
      new Response('x'.repeat(262145)),
      new Response('bad', { status: 429 }),
    ]) {
      let calls = 0;
      const provider = new JupiterReadOnlyQuoteProvider({
        fetch: async () => {
          calls++;
          return res;
        },
      });
      expect(await provider.quote(request)).toEqual({
        status: 'unavailable',
        reason: 'JUPITER_REQUIRED_QUOTE_EVIDENCE_UNAVAILABLE',
      });
      expect(calls).toBe(1);
    }
  });
  it('uses monotonic request duration even if the UTC clock stalls', async () => {
    let ticks = 0;
    const provider = new JupiterReadOnlyQuoteProvider({
      clock: () => 1000000,
      monotonicClock: () => (ticks++ ? 2001 : 0),
      fetch: async () => new Response(JSON.stringify(response())),
    });
    expect((await provider.quote(request)).status).toBe('unavailable');
  });
});
