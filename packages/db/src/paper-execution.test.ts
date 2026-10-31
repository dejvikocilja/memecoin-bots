import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovedOrderIntent, Executor, PaperModel, QuoteEvidence } from '@memebots/core';
import { createExecutor, createTestExecutor } from '@memebots/core';
import { PaperBroker } from '../../../apps/engine/src/paper/broker.js';
import type { PaperQuoteProvider, QuoteRequest } from '../../../apps/engine/src/paper/quote.js';
import {
  normalizeJupiterQuote,
  unavailableSnapshotQuote,
} from '../../../apps/engine/src/paper/quote.js';
import { drawModel } from '../../../apps/engine/src/paper/model.js';
import {
  inspectPaperOrder,
  loadPaperIntent,
  preparePaperAttempt,
  registerPaperIntent,
  reservePaperQuoteRequest,
  savePaperQuote,
  settlePaperAttempt,
} from './paper-execution.js';
import { loadMigrations, migrateDown, migrateUp, migrationStatus } from './migrate.js';
import { createTestPool, hasTestDatabase, resetDatabase, TEST_DATABASE_URL } from './test-db.js';
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL = 'So11111111111111111111111111111111111111112';
const model: PaperModel = {
  version: 'paper-v1',
  minLatencyMs: 10,
  maxLatencyMs: 10,
  adverseSlippageBps: 100,
  failureProbability: 0,
  failureStage: 'submitted',
  partialFillBps: 10000,
  fees: {
    provenance: 'MODEL',
    selectedBy: 'test-owner',
    networkLamports: '5',
    priorityLamports: '2',
  },
};
const command = promisify(execFile);
function jsonQuote(request: QuoteRequest) {
  const [inputMint, outputMint] = request.intent.side === 'buy' ? [SOL, MINT] : [MINT, SOL];
  const output = (BigInt(request.inputRaw) * 2n).toString();
  return {
    router: 'metis',
    transaction: null,
    inputMint,
    outputMint,
    inAmount: request.inputRaw,
    outAmount: output,
    otherAmountThreshold: ((BigInt(output) * 9700n + 9999n) / 10000n).toString(),
    swapMode: 'ExactIn',
    slippageBps: 300,
    gasless: false,
    taker: null,
    feeBps: 10,
    feeMint: inputMint,
    platformFee: { amount: '1', feeBps: 10, feeMint: inputMint },
    routePlan: [
      {
        bps: 10000,
        swapInfo: {
          ammKey: MINT,
          inputMint,
          outputMint,
          inAmount: request.inputRaw,
          outAmount: output,
        },
      },
    ],
  };
}
describe.skipIf(!hasTestDatabase)('durable paper execution', () => {
  const pool = hasTestDatabase ? createTestPool() : undefined!;
  let now = 1000000;
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrateUp(pool);
    now = 1000000;
  });
  afterAll(async () => pool.end());
  async function seed(
    bankroll = '1000000000000000000000000000000000000',
    decimals = 18,
  ): Promise<string> {
    await pool.query(
      `INSERT INTO risk_profiles(id,display_name,position_fraction,stop_loss_fraction,take_profit_ladder,trailing_stop_fraction,min_reward_risk,max_open_positions,daily_loss_limit_fraction,max_slippage_bps,min_liquidity_usd,min_safety_score,max_hold_minutes,losing_streak_limit) VALUES('balanced','Balanced',0.02,0.20,'[{"atGain":0.3,"sellFraction":0.4},{"atGain":0.6,"sellFraction":0.3}]',0.15,2,5,0.06,300,50000,60,720,4) ON CONFLICT DO NOTHING`,
    );
    await pool.query('INSERT INTO tokens(mint,decimals) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      MINT,
      decimals,
    ]);
    const wallet = await pool.query<{ id: string }>(
      "INSERT INTO wallets(label,public_key) VALUES('paper public test label',$1) RETURNING id",
      [`P${randomUUID().replaceAll('-', '').replaceAll('0', 'G')}`],
    );
    return (
      await pool.query<{ id: string }>(
        "INSERT INTO bots(name,strategy,risk_profile_id,wallet_id,mode,paper_bankroll_lamports) VALUES($1,'paper_test','balanced',$2,'paper',$3) RETURNING id",
        [randomUUID(), wallet.rows[0]!.id, bankroll],
      )
    ).rows[0]!.id;
  }
  async function order(
    botId: string,
    changes: Partial<ApprovedOrderIntent> = {},
  ): Promise<ApprovedOrderIntent> {
    const id = randomUUID();
    const intent: ApprovedOrderIntent = {
      orderId: id,
      clientOrderId: `test:${id}`,
      botId,
      positionId: null,
      tokenMint: MINT,
      side: 'buy',
      mode: 'paper',
      amountInRaw: '1000',
      maxSlippageBps: 300,
      expiresAt: now + 60000,
      approval: { kind: 'manual_paper_scenario', reference: 'owner-test' },
      quoteRequirements: {
        freshnessPolicy: 'bounded_request_age',
        maxAgeMs: 5000,
        maxSlotLag: 20,
        fullyObservedCosts: false,
      },
      entry: { stopPriceSol: '0.000001', takeProfit: [{ atGain: 0.3, sellFraction: 0.5 }] },
      closeReason: null,
      ...changes,
    };
    await pool.query(
      'INSERT INTO orders(id,client_order_id,bot_id,position_id,token_mint,side,mode,amount_in_raw,max_slippage_bps,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        id,
        intent.clientOrderId,
        intent.botId,
        intent.positionId,
        intent.tokenMint,
        intent.side,
        intent.mode,
        intent.amountInRaw,
        intent.maxSlippageBps,
        intent.approval.kind,
      ],
    );
    await registerPaperIntent(pool, intent);
    return intent;
  }
  function provider(): PaperQuoteProvider {
    return {
      quote: async (request) => ({
        status: 'available',
        quote: normalizeJupiterQuote(jsonQuote(request), request, now, now, true),
      }),
      currentContext: async () => ({ slot: 101, blockTimeMs: now - 500, observedAt: now }),
    };
  }
  function broker(
    m = model,
    p = provider(),
    sleep: ((ms: number) => Promise<void>) | undefined = undefined,
  ) {
    return new PaperBroker(pool, p, m, {
      clock: () => now,
      sleep:
        sleep ??
        (async (ms) => {
          now += ms;
        }),
      seed: () => 'a'.repeat(64),
    });
  }
  async function state(botId: string) {
    return {
      balance: (
        await pool.query<{ paper_bankroll_lamports: string }>(
          'SELECT paper_bankroll_lamports FROM bots WHERE id=$1',
          [botId],
        )
      ).rows[0]!.paper_bankroll_lamports,
      positions: (await pool.query('SELECT * FROM positions WHERE bot_id=$1', [botId])).rows,
      fills: (await pool.query('SELECT * FROM fills')).rows,
    };
  }
  it.each([0, 18])(
    'both sides exact above 2^53, decimals %s, embedded fees not deducted twice',
    async (decimals) => {
      const initial = '1000000000000000000000000000000000000';
      const botId = await seed(initial, decimals);
      const amount = '9007199254740993123456789';
      const buy = await order(botId, { amountInRaw: amount });
      const first = await broker().execute(buy, 'buy');
      expect(first).toMatchObject({
        status: 'filled',
        inputRaw: amount,
        outputRaw: ((BigInt(amount) * 2n * 9900n) / 10000n).toString(),
        networkFeeLamports: '5',
        priorityFeeLamports: '2',
        costsProvenance: 'MODEL',
      });
      const s = await state(botId);
      expect(s.balance).toBe((BigInt(initial) - BigInt(amount) - 7n).toString());
      expect(s.positions[0].remaining_raw).toBe(first.outputRaw);
      expect(s.positions[0].cost_lamports).toBe((BigInt(amount) + 7n).toString());
      expect(s.fills[0]).toMatchObject({
        mode: 'paper',
        tx_signature: null,
        price_usd: null,
        sol_usd_rate: null,
        network_fee_lamports: '5',
        priority_fee_lamports: '2',
      });
      const sell = await order(botId, {
        side: 'sell',
        positionId: s.positions[0].id,
        amountInRaw: first.outputRaw,
        entry: null,
        closeReason: 'manual',
      });
      const second = await broker().execute(sell, 'sell');
      expect(second.status).toBe('filled');
      const end = await state(botId);
      expect(end.positions[0].remaining_raw).toBe('0');
      expect(end.positions[0].status).toBe('closed');
      expect(end.balance).toBe(
        (BigInt(initial) - BigInt(amount) - 14n + BigInt(second.outputRaw)).toString(),
      );
      expect(end.positions[0].realized_pnl_lamports).toBe(
        (BigInt(second.outputRaw) - BigInt(amount) - 14n).toString(),
      );
    },
  );
  it('same execution caller can substitute the actual paper broker and injected fake-live contract', async () => {
    const o = await order(await seed('10000'));
    const paper = broker();
    let fakeCalls = 0;
    const fakeLive: Executor = {
      execute: async (intent) => {
        fakeCalls++;
        return {
          attemptId: 'fake-only',
          orderId: intent.orderId,
          status: 'filled',
          reason: 'TEST_FAKE_LIVE',
          inputRaw: intent.amountInRaw,
          outputRaw: '1980',
          networkFeeLamports: '5',
          priorityFeeLamports: '2',
          costsProvenance: 'MODEL',
        };
      },
      inspect: async () => [],
      cancel: async () => {},
    };
    const caller = (executor: Executor, intent: ApprovedOrderIntent) =>
      executor.execute(intent, 'contract');
    for (const mode of ['paper', 'live'] as const) {
      const result = await caller(createTestExecutor(mode, { paper, fakeLive }), { ...o, mode });
      expect(result.status).toBe('filled');
      expect(result.outputRaw).toBe('1980');
    }
    expect(fakeCalls).toBe(1);
    expect((await state(o.botId)).fills).toHaveLength(1);
    expect(() => createExecutor('live', paper)).toThrow('LIVE_EXECUTOR_UNAVAILABLE');
  });
  it('zero-slippage persisted order fills only when the exact quoted output is retained', async () => {
    const o = await order(await seed('10000'), { maxSlippageBps: 0 });
    const source: PaperQuoteProvider = {
      quote: async (request) => {
        const r = jsonQuote(request);
        return {
          status: 'available',
          quote: normalizeJupiterQuote(
            { ...r, slippageBps: 0, otherAmountThreshold: r.outAmount },
            request,
            now,
            now,
            true,
          ),
        };
      },
      currentContext: async () => undefined,
    };
    expect(
      (await broker({ ...model, adverseSlippageBps: 0 }, source).execute(o, 'zero')).status,
    ).toBe('filled');
  });
  it.each(['quote', 'intent'] as const)(
    'rejects %s expiry while waiting on a settlement lock',
    async (expiry) => {
      const botId = await seed('10000');
      const o = await order(
        botId,
        expiry === 'intent'
          ? { expiresAt: now + 100 }
          : {
              quoteRequirements: {
                freshnessPolicy: 'bounded_request_age',
                maxAgeMs: 100,
                maxSlotLag: 20,
                fullyObservedCosts: false,
              },
            },
      );
      const blocker = await pool.connect();
      let ready!: () => void;
      const locked = new Promise<void>((resolve) => {
        ready = resolve;
      });
      try {
        const executing = broker(model, provider(), async (ms) => {
          now += ms;
          await blocker.query('BEGIN');
          await blocker.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [botId]);
          ready();
        }).execute(o, 'delayed-lock');
        await locked;
        await new Promise((resolve) => setTimeout(resolve, 20));
        now += 400;
        await blocker.query('COMMIT');
        const result = await executing;
        expect(result.status).toBe('failed');
        expect(result.reason).toBe(
          expiry === 'intent' ? 'INTENT_EXPIRED' : 'QUOTE_EXPIRED_OR_CHAIN_CONTEXT_UNAVAILABLE',
        );
        expect((await state(botId)).balance).toBe('10000');
        expect((await state(botId)).fills).toHaveLength(0);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
    },
  );
  it('old partial buy cannot attach to a later position after its original holding closes', async () => {
    const botId = await seed('10000');
    const a = await order(botId);
    await broker({ ...model, partialFillBps: 5000 }).execute(a, 'a1');
    const original = (await state(botId)).positions[0];
    const sale = await order(botId, {
      side: 'sell',
      positionId: original.id,
      amountInRaw: original.remaining_raw,
      entry: null,
      closeReason: 'manual',
    });
    await broker().execute(sale, 'close');
    const b = await order(botId, {
      entry: { stopPriceSol: '0.000002', takeProfit: [{ atGain: 0.8, sellFraction: 0.7 }] },
    });
    await broker().execute(b, 'b1');
    const before = await state(botId);
    const later = before.positions.find((p) => p.id !== original.id)!;
    const result = await broker().execute(await loadPaperIntent(pool, a.orderId), 'a2');
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'POSITION_MISMATCH',
      networkFeeLamports: '0',
    });
    expect(await broker().execute(a, 'a2')).toEqual(result);
    const after = await state(botId);
    expect(after.balance).toBe(before.balance);
    expect(after.positions.find((p) => p.id === later.id)).toEqual(later);
    expect(after.fills).toHaveLength(3);
    const association = await pool.query(
      'SELECT position_id FROM paper_execution_positions WHERE order_id=$1',
      [a.orderId],
    );
    expect(association.rows[0].position_id).toBe(original.id);
    await expect(
      pool.query('UPDATE paper_execution_positions SET position_id=$1 WHERE order_id=$2', [
        later.id,
        a.orderId,
      ]),
    ).rejects.toThrow('append-only');
  });
  it('same key replay and concurrent duplicate produce exactly one fill', async () => {
    const botId = await seed();
    const o = await order(botId);
    let quoteCalls = 0;
    const source = provider();
    const b = broker(model, {
      quote: async (request) => {
        quoteCalls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return source.quote(request);
      },
      currentContext: () => source.currentContext(),
    });
    const [a, c] = await Promise.all([b.execute(o, 'same'), b.execute(o, 'same')]);
    expect(a).toEqual(c);
    expect(quoteCalls).toBe(1);
    expect(await b.execute(o, 'same')).toEqual(a);
    expect((await state(botId)).fills).toHaveLength(1);
    expect((await pool.query('SELECT * FROM paper_execution_attempts')).rows).toHaveLength(1);
    await expect(
      pool.query('UPDATE paper_execution_attempts SET seed=$1', ['b'.repeat(64)]),
    ).rejects.toThrow('append-only');
    await expect(pool.query('DELETE FROM paper_execution_results')).rejects.toThrow('append-only');
  });
  it('rejects changed immutable intent, unapproved/vetoed/mismatched mode and reused key', async () => {
    const botId = await seed();
    const a = await order(botId);
    await expect(broker().execute({ ...a, amountInRaw: '1' }, 'a')).rejects.toThrow(
      'PERSISTED_ORDER_MISMATCH',
    );
    await expect(
      broker().execute({ ...a, approval: { ...a.approval, reference: 'different' } }, 'a'),
    ).rejects.toThrow('INTENT_MISMATCH');
    await broker().execute(a, 'a');
    const b = await order(await seed());
    await expect(broker().execute(b, 'a')).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await pool.query("UPDATE orders SET status='vetoed',veto_reason='blocked' WHERE id=$1", [
      b.orderId,
    ]);
    await expect(broker().execute(b, 'b')).rejects.toThrow('PERSISTED_ORDER_MISMATCH');
    await pool.query("UPDATE bots SET mode='off' WHERE id=$1", [botId]);
    await expect(broker().execute(a, 'a')).rejects.toThrow('PERSISTED_ORDER_MISMATCH');
    const missing = await order(await seed());
    await pool.query(
      'ALTER TABLE paper_execution_intents DISABLE TRIGGER paper_execution_intents_append_only',
    );
    await pool.query('DELETE FROM paper_execution_intents WHERE order_id=$1', [missing.orderId]);
    await expect(broker().execute(missing, 'm')).rejects.toThrow('APPROVED_INTENT_REQUIRED');
  });
  it('concurrent orders cannot overdraw bankroll, and no unused holds survive', async () => {
    const botId = await seed('1500');
    const a = await order(botId),
      b = await order(botId);
    const results = await Promise.all([broker().execute(a, 'a'), broker().execute(b, 'b')]);
    expect(results.filter((r) => r.status === 'filled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'failed')!.reason).toBe('INSUFFICIENT_PAPER_SOL');
    expect((await state(botId)).balance).toBe('493');
    expect((await state(botId)).fills).toHaveLength(1);
  });
  it('concurrent sell orders cannot overdraw holdings', async () => {
    const botId = await seed('10000');
    const buy = await broker().execute(await order(botId), 'buy');
    const s = await state(botId);
    const a = await order(botId, {
      side: 'sell',
      positionId: s.positions[0].id,
      amountInRaw: buy.outputRaw,
      entry: null,
      closeReason: 'manual',
    });
    const b = await order(botId, {
      side: 'sell',
      positionId: s.positions[0].id,
      amountInRaw: buy.outputRaw,
      entry: null,
      closeReason: 'manual',
    });
    const results = await Promise.all([broker().execute(a, 'a'), broker().execute(b, 'b')]);
    expect(results.filter((r) => r.status === 'filled')).toHaveLength(1);
    expect((await state(botId)).positions[0].remaining_raw).toBe('0');
    expect((await state(botId)).fills).toHaveLength(2);
  });
  it('partial fill uses an amount-specific quote, correct remainder and one fee per attempt', async () => {
    const botId = await seed('10000');
    const o = await order(botId);
    const first = await broker({ ...model, partialFillBps: 5000 }).execute(o, 'p1');
    expect(first).toMatchObject({ status: 'partial', inputRaw: '500', outputRaw: '990' });
    expect((await state(botId)).balance).toBe('9493');
    expect(await broker().execute(o, 'p1')).toEqual(first);
    const second = await broker().execute(o, 'p2');
    expect(second).toMatchObject({ status: 'filled', inputRaw: '500', outputRaw: '990' });
    const s = await state(botId);
    expect(s.balance).toBe('8986');
    expect(s.positions[0].remaining_raw).toBe('1980');
    expect(s.positions[0].cost_lamports).toBe('1014');
    expect(s.fills).toHaveLength(2);
  });
  it.each(['before_submission', 'submitted'] as const)(
    'failure p=1 charges fee once only for %s',
    async (stage) => {
      const botId = await seed('10000'),
        o = await order(botId);
      const b = broker({ ...model, failureProbability: 1, failureStage: stage });
      const result = await b.execute(o, 'fail');
      expect(result.status).toBe('failed');
      expect(await b.execute(o, 'fail')).toEqual(result);
      const s = await state(botId);
      expect(s.balance).toBe(stage === 'submitted' ? '9993' : '10000');
      expect(s.fills).toHaveLength(0);
      expect(s.positions).toHaveLength(0);
    },
  );
  it('slippage threshold equality fills exactly; lower output fails', async () => {
    const botId = await seed('10000');
    const result = await broker({ ...model, adverseSlippageBps: 300 }).execute(
      await order(botId),
      'limit',
    );
    expect(result.status).toBe('filled');
    expect(result.outputRaw).toBe('1940');
    const o = await order(await seed('10000'));
    expect((await broker({ ...model, adverseSlippageBps: 301 }).execute(o, 'below')).reason).toBe(
      'SLIPPAGE_LIMIT',
    );
  });
  it('latency expiry and fully observed cost requirement fail closed', async () => {
    const botId = await seed('10000');
    const expired = await order(botId, { expiresAt: now + 1 });
    expect((await broker().execute(expired, 'expire')).reason).toBe('INTENT_EXPIRED');
    const o = await order(botId, {
      quoteRequirements: {
        freshnessPolicy: 'bounded_request_age',
        maxAgeMs: 5000,
        maxSlotLag: 20,
        fullyObservedCosts: true,
      },
    });
    expect((await broker().execute(o, 'observed')).reason).toBe(
      'FULLY_OBSERVED_NETWORK_PRIORITY_FEES_UNAVAILABLE',
    );
    expect((await state(botId)).fills).toHaveLength(0);
  });
  it('quote expires during latency even while approval stays valid', async () => {
    const botId = await seed('10000');
    const result = await broker({ ...model, minLatencyMs: 20000, maxLatencyMs: 20000 }).execute(
      await order(botId),
      'stale',
    );
    expect(result.reason).toBe('QUOTE_EXPIRED_OR_CHAIN_CONTEXT_UNAVAILABLE');
    expect((await state(botId)).balance).toBe('10000');
  });
  it('submitted failure cannot charge an order that could not afford its principal', async () => {
    const botId = await seed('10');
    const result = await broker({ ...model, failureProbability: 1 }).execute(
      await order(botId),
      'unfunded',
    );
    expect(result.reason).toBe('INSUFFICIENT_PAPER_SOL');
    expect(result.networkFeeLamports).toBe('0');
    expect((await state(botId)).balance).toBe('10');
  });
  it('persists explicit unavailable snapshots, no bankroll debit', async () => {
    const botId = await seed('10000');
    const o = await order(botId);
    const result = await broker(model, {
      quote: async () => unavailableSnapshotQuote,
      currentContext: async () => undefined,
    }).execute(o, 'snapshot');
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('DEXSCREENER_SNAPSHOT_NOT_EXECUTABLE_QUOTE');
    expect((await state(botId)).balance).toBe('10000');
    expect(
      (await pool.query('SELECT evidence FROM paper_execution_quotes')).rows[0].evidence,
    ).toEqual(unavailableSnapshotQuote);
  });
  it('cancel during latency and restart recover without rerolls or duplicate fills', async () => {
    const botId = await seed('10000');
    const o = await order(botId);
    const interrupted = broker(model, provider(), async () => {
      throw new Error('INTERRUPTED');
    });
    await expect(interrupted.execute(o, 'recover')).rejects.toThrow('INTERRUPTED');
    expect((await state(botId)).fills).toHaveLength(0);
    const attempt = (await pool.query('SELECT * FROM paper_execution_attempts')).rows[0];
    await expect(broker().execute(o, 'other')).rejects.toThrow('RECOVERY_REQUIRED');
    now += 10;
    const result = await broker({ ...model, failureProbability: 1 }).execute(o, 'recover');
    expect(result.status).toBe('filled');
    expect((await pool.query('SELECT seed,model FROM paper_execution_attempts')).rows[0]).toEqual({
      seed: attempt.seed,
      model: attempt.model,
    });
    const p = await order(await seed('10000'));
    const cancelling = broker(model, provider(), async (ms) => {
      now += ms;
      await broker().cancel(p.orderId);
    });
    expect((await cancelling.execute(p, 'cancel')).status).toBe('cancelled');
    expect((await inspectPaperOrder(pool, p.orderId))[0]!.networkFeeLamports).toBe('0');
  });
  it('rollback after fill insertion preserves original attempt for safe retry', async () => {
    const botId = await seed('10000'),
      o = await order(botId);
    await pool.query(
      "CREATE FUNCTION paper_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_FAILURE'; END $$; CREATE TRIGGER paper_test_fault BEFORE INSERT ON paper_execution_results FOR EACH ROW EXECUTE FUNCTION paper_test_fault()",
    );
    await expect(broker().execute(o, 'retry')).rejects.toThrow('TEST_FAILURE');
    expect((await state(botId)).balance).toBe('10000');
    expect((await state(botId)).fills).toHaveLength(0);
    await pool.query(
      'DROP TRIGGER paper_test_fault ON paper_execution_results; DROP FUNCTION paper_test_fault()',
    );
    expect((await broker().execute(o, 'retry')).status).toBe('filled');
    expect((await state(botId)).fills).toHaveLength(1);
  });
  it('immutable attempts/quote/result reject direct overwrite and settlement input spoof', async () => {
    const o = await order(await seed());
    const randomSeed = 'a'.repeat(64);
    const attempt = await preparePaperAttempt(
      pool,
      o,
      'spoof',
      model,
      randomSeed,
      drawModel(randomSeed, model),
      now,
    );
    const evidence: QuoteEvidence = {
      status: 'available',
      quote: normalizeJupiterQuote(
        jsonQuote({ intent: o, inputRaw: attempt.inputRaw }),
        { intent: o, inputRaw: attempt.inputRaw },
        now - 1000,
        now,
        true,
      ),
    };
    await savePaperQuote(pool, attempt.id, evidence);
    now += 10;
    await expect(
      settlePaperAttempt(
        pool,
        attempt,
        {
          attemptId: attempt.id,
          orderId: o.orderId,
          status: 'filled',
          reason: 'SIMULATED_FILL',
          inputRaw: attempt.inputRaw,
          outputRaw: '999999',
          networkFeeLamports: '5',
          priorityFeeLamports: '2',
          costsProvenance: 'MODEL',
        },
        () => now,
      ),
    ).rejects.toThrow('RESULT_OUTPUT_MISMATCH');
    await expect(pool.query("UPDATE paper_execution_quotes SET evidence='{}'")).rejects.toThrow(
      'append-only',
    );
  });
  it('an interrupted durable quote claim is unavailable on recovery, never silently refetched', async () => {
    const o = await order(await seed('10000'));
    const randomSeed = 'a'.repeat(64);
    const attempt = await preparePaperAttempt(
      pool,
      o,
      'claim',
      model,
      randomSeed,
      drawModel(randomSeed, model),
      now,
    );
    await pool.query(
      'INSERT INTO paper_execution_quote_claims(attempt_id,claimed_at_ms) VALUES($1,$2)',
      [attempt.id, now],
    );
    let calls = 0;
    const source = provider();
    const b = broker(model, {
      quote: async (request) => {
        calls++;
        return source.quote(request);
      },
      currentContext: () => source.currentContext(),
    });
    const result = await b.execute(o, 'claim');
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'QUOTE_ACQUISITION_INTERRUPTED',
    });
    expect(calls).toBe(0);
    expect(await b.execute(o, 'claim')).toEqual(result);
  });
  it('durable 20rpm quote/RPC budget survives a new caller', async () => {
    await pool.query(
      "INSERT INTO paper_execution_requests(requested_at) SELECT clock_timestamp()-(s*interval '2 seconds') FROM generate_series(1,19) s",
    );
    await reservePaperQuoteRequest(pool);
    await expect(reservePaperQuoteRequest(pool)).rejects.toThrow('QUOTE_RATE_LIMIT');
    expect((await pool.query('SELECT * FROM paper_execution_requests')).rows).toHaveLength(20);
  });
  it('migration0011 has a reversible lifecycle even with later migrations available', async () => {
    const all = await loadMigrations();
    const target = all.find((m) => m.version === '0011')!;
    expect(target).toBeDefined();
    const later = all.filter((m) => m.version > '0011');
    await migrateDown(pool, later.length + 1);
    expect((await migrationStatus(pool)).find((m) => m.version === '0011')!.appliedAt).toBe(null);
    await migrateUp(pool, [target, ...later]);
    expect(
      (await migrationStatus(pool)).find((m) => m.version === '0011')!.appliedAt,
    ).toBeInstanceOf(Date);
  });
  it('CLI local HTTP mock + PostgreSQL collect/persist/inspect/recover and BOT7 unavailable', async () => {
    const server = createServer((req, res) => {
      void (async () => {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        if (req.method === 'POST') {
          const rpc = JSON.parse(body) as { method: string };
          res.end(
            JSON.stringify({
              id: 1,
              result: rpc.method === 'getSlot' ? 101 : Math.floor(Date.now() / 1000) - 1,
            }),
          );
          return;
        }
        const url = new URL(req.url!, 'http://localhost');
        const request: QuoteRequest = {
          intent: {
            side: url.searchParams.get('inputMint') === SOL ? 'buy' : 'sell',
            tokenMint: MINT,
            maxSlippageBps: 300,
          } as ApprovedOrderIntent,
          inputRaw: url.searchParams.get('amount')!,
        };
        res.end(JSON.stringify(jsonQuote(request)));
      })().catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || !address) throw new Error('server');
    const dir = await mkdtemp(join(tmpdir(), 'paper-cli-'));
    try {
      const scenario = {
        tokenMint: MINT,
        decimals: 5,
        amountInRaw: '1000',
        bankrollLamports: '10000',
        maxSlippageBps: 300,
        expiresInMs: 60000,
        quoteRequirements: {
          freshnessPolicy: 'bounded_request_age',
          maxAgeMs: 5000,
          maxSlotLag: 20,
          fullyObservedCosts: false,
        },
        entry: { stopPriceSol: '0.000001', takeProfit: [{ atGain: 0.3, sellFraction: 0.5 }] },
        model,
      };
      const path = join(dir, 'scenario.json');
      await writeFile(path, JSON.stringify(scenario));
      const cli = resolve('apps/engine/src/paper/cli.ts');
      const cwd = resolve('.');
      const run = (args: string[], extra: Record<string, string> = {}) =>
        command(
          process.execPath,
          ['--import', 'tsx', '--conditions=@memebots/source', cli, ...args],
          {
            cwd,
            env: {
              ...process.env,
              DATABASE_URL: TEST_DATABASE_URL,
              PAPER_QUOTE_MOCK_URL: `http://127.0.0.1:${address.port}`,
              ...extra,
            },
          },
        );
      const demo = await run(['manual-demo', path]);
      const result = (
        JSON.parse(demo.stdout.trim().split('\n').at(-1)!) as {
          fields: {
            result: { orderId: string; attemptId: string; status: string; outputRaw: string };
          };
        }
      ).fields.result;
      expect(result).toMatchObject({ status: 'filled', outputRaw: '1980' });
      const inspected = await run(['inspect', result.orderId]);
      expect(inspected.stdout).toContain('"outputRaw":"1980"');
      const row = (await pool.query('SELECT * FROM fills WHERE order_id=$1', [result.orderId]))
        .rows[0];
      expect(row.network_fee_lamports).toBe('5');
      expect(row.slippage_bps).toBe(100);
      const intent = await loadPaperIntent(pool, result.orderId);
      await run(['recover', result.orderId, `demo:${intent.orderId}`, path]);
      expect((await pool.query('SELECT * FROM fills')).rows).toHaveLength(1);
      const unavailable = await run(['manual-demo', path], { PAPER_QUOTE_SOURCE: 'dex_snapshot' });
      expect(unavailable.stdout).toContain('DEXSCREENER_SNAPSHOT_NOT_EXECUTABLE_QUOTE');
      expect(unavailable.stdout).toContain('"status":"unavailable"');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
});
