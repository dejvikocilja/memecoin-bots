import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ApprovedOrderIntent,
  ExecutionResult,
  Executor,
  PaperModel,
  QuoteEvidence,
} from '@memebots/core';
import {
  cancelPaperOrder,
  inspectPaperOrder,
  acquirePaperQuote,
  preparePaperAttempt,
  settlePaperAttempt,
  validatePaperIntent,
} from '@memebots/db';
import type { Pool } from '@memebots/db';
import { drawModel, simulateOutput, validateModel } from './model.js';
import type { PaperQuoteProvider } from './quote.js';
import { quoteIsFresh, validateExecutableQuote } from './quote.js';

export class PaperBroker implements Executor {
  private readonly model: PaperModel;
  constructor(
    private readonly pool: Pool,
    private readonly provider: PaperQuoteProvider,
    model: PaperModel,
    private readonly runtime: {
      clock?: () => number;
      monotonicClock?: () => number;
      sleep?: (ms: number) => Promise<void>;
      seed?: () => string;
      signal?: AbortSignal;
    } = {},
  ) {
    validateModel(model);
    this.model = JSON.parse(JSON.stringify(model)) as PaperModel;
  }
  inspect(orderId: string): Promise<readonly ExecutionResult[]> {
    return inspectPaperOrder(this.pool, orderId);
  }
  cancel(orderId: string): Promise<void> {
    return cancelPaperOrder(this.pool, orderId);
  }
  async execute(input: ApprovedOrderIntent, key: string): Promise<ExecutionResult> {
    // Snapshot to prevent caller mutation across asynchronous quote/latency boundaries.
    const intent = JSON.parse(JSON.stringify(input)) as ApprovedOrderIntent;
    validatePaperIntent(intent);
    const clock = this.runtime.clock ?? Date.now;
    const monotonicClock = this.runtime.monotonicClock ?? (() => performance.now());
    const startedUtc = clock();
    const startedMono = monotonicClock();
    if (!Number.isFinite(startedMono) || startedMono < 0)
      throw new Error('INVALID_MONOTONIC_CLOCK');
    let lastMono = startedMono;
    let invalidMonotonic = false;
    let monotonicDeadline = startedMono + Math.max(0, intent.expiresAt - startedUtc);
    const monotonicNow = (): number => {
      const sample = monotonicClock();
      if (invalidMonotonic || !Number.isFinite(sample) || sample < lastMono) {
        invalidMonotonic = true;
        return Number.POSITIVE_INFINITY;
      }
      lastMono = sample;
      return sample;
    };
    const stillFresh = (): boolean => monotonicNow() < monotonicDeadline;

    const seed = (this.runtime.seed ?? (() => randomBytes(32).toString('hex')))();
    const attempt = await preparePaperAttempt(
      this.pool,
      intent,
      key,
      this.model,
      seed,
      drawModel(seed, this.model),
      clock(),
    );
    const previous = (await this.inspect(intent.orderId)).find((r) => r.attemptId === attempt.id);
    if (previous) return previous;
    const evidence = await acquirePaperQuote(this.pool, attempt.id, clock(), async () => {
      try {
        const fetched = await this.provider.quote({ intent, inputRaw: attempt.inputRaw });
        if (fetched.status === 'unavailable' && !/^[A-Z0-9_]{1,80}$/.test(fetched.reason))
          throw new Error('INVALID_REASON');
        if (fetched.status === 'available')
          validateExecutableQuote(fetched.quote, { intent, inputRaw: attempt.inputRaw });
        return fetched;
      } catch {
        return { status: 'unavailable', reason: 'INVALID_QUOTE_EVIDENCE' };
      }
    });
    if (evidence.status === 'available') {
      // Start from this call's earliest monotonic observation, conservatively including
      // DB/quote acquisition time; persisted UTC bounds recovery in a new process.
      const q = evidence.quote;
      monotonicDeadline = Math.min(
        monotonicDeadline,
        startedMono + Math.max(0, q.expiresAt - q.requestStartedAt),
        monotonicNow() + Math.max(0, q.expiresAt - clock()),
      );
    }
    const monotonicReadyAt = startedMono + Math.max(0, attempt.readyAt - startedUtc);
    const wait = Math.max(attempt.readyAt - clock(), monotonicReadyAt - monotonicNow());
    if (wait > 0) {
      if (this.runtime.sleep) await this.runtime.sleep(wait);
      else await delay(wait, undefined, { signal: this.runtime.signal });
    }
    this.runtime.signal?.throwIfAborted();
    const base: ExecutionResult = {
      attemptId: attempt.id,
      orderId: intent.orderId,
      status: 'unavailable',
      reason: 'QUOTE_UNAVAILABLE',
      inputRaw: '0',
      outputRaw: '0',
      networkFeeLamports: '0',
      priorityFeeLamports: '0',
      costsProvenance: 'MODEL',
    };
    const zero: ExecutionResult = savedProvenance(evidence, base);
    let result: ExecutionResult;
    const saved: QuoteEvidence = evidence;
    if (intent.quoteRequirements.fullyObservedCosts)
      result = { ...zero, reason: 'FULLY_OBSERVED_NETWORK_PRIORITY_FEES_UNAVAILABLE' };
    else if (saved.status === 'unavailable') result = { ...zero, reason: saved.reason };
    else {
      let valid = true;
      try {
        validateExecutableQuote(saved.quote, { intent, inputRaw: attempt.inputRaw });
      } catch {
        valid = false;
      }
      const current =
        valid && saved.quote.freshnessBasis === 'chain_context'
          ? await this.provider.currentContext()
          : undefined;
      const now = clock();
      if (!stillFresh())
        result = { ...zero, status: 'failed', reason: 'MONOTONIC_DEADLINE_EXPIRED' };
      else if (!valid) result = { ...zero, reason: 'INVALID_QUOTE_EVIDENCE' };
      else if (!quoteIsFresh(saved.quote, intent, current, now))
        result = {
          ...zero,
          status: 'failed',
          reason: 'QUOTE_EXPIRED_OR_CHAIN_CONTEXT_UNAVAILABLE',
        };
      else {
        const fees = {
          networkFeeLamports: attempt.model.fees.networkLamports,
          priorityFeeLamports: attempt.model.fees.priorityLamports,
        };
        const output = simulateOutput(saved.quote.outputRaw, attempt.model.adverseSlippageBps);
        if (BigInt(output) < BigInt(saved.quote.minimumOutputRaw))
          result = { ...zero, status: 'failed', reason: 'SLIPPAGE_LIMIT' };
        else if (
          attempt.draws.failurePpm < Math.floor(attempt.model.failureProbability * 1_000_000)
        )
          result = {
            ...zero,
            status: 'failed',
            reason:
              attempt.model.failureStage === 'submitted'
                ? 'SIMULATED_SUBMITTED_FAILURE'
                : 'SIMULATED_PREFLIGHT_FAILURE',
            ...(attempt.model.failureStage === 'submitted' ? fees : {}),
          };
        else
          result = {
            ...zero,
            ...fees,
            status: 'filled',
            reason: 'SIMULATED_FILL',
            inputRaw: attempt.inputRaw,
            outputRaw: output,
          };
      }
    }
    return settlePaperAttempt(this.pool, attempt, result, clock, stillFresh);
  }
}

function savedProvenance(evidence: QuoteEvidence, base: ExecutionResult): ExecutionResult {
  return evidence.status === 'available'
    ? {
        ...base,
        quoteProvenance: {
          provider: evidence.quote.provider,
          freshnessBasis: evidence.quote.freshnessBasis,
          feeBreakdownCompleteness: evidence.quote.feeBreakdownCompleteness,
          unknownFeeComponents: evidence.quote.unknownFeeComponents,
        },
      }
    : base;
}
