import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovedOrderIntent, PaperModel } from '@memebots/core';
import { PaperBroker } from '../../../apps/engine/src/paper/broker.js';
import { normalizeJupiterQuote } from '../../../apps/engine/src/paper/quote.js';
import type { PaperQuoteProvider, QuoteRequest } from '../../../apps/engine/src/paper/quote.js';
import {
  buyBlockReason,
  engageKillSwitch,
  getKillSwitch,
  killSwitchSellAll,
  releaseKillSwitch,
  resumePausedBot,
} from './kill-switch.js';
import { claimExitPosition, decidePositionExit } from './position-exits.js';
import { registerPaperIntent } from './paper-execution.js';
import { resumeControlledBot, botControlSnapshot } from './bot-control.js';
import { migrateDown, migrateUp } from './migrate.js';
import { createPool, withTransaction } from './pool.js';
import type { Pool } from './pool.js';
import { createTestPool, hasTestDatabase, resetDatabase, TEST_DATABASE_URL } from './test-db.js';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL = 'So11111111111111111111111111111111111111112';
const MODEL: PaperModel = {
  version: 'paper-v1',
  minLatencyMs: 0,
  maxLatencyMs: 0,
  adverseSlippageBps: 0,
  failureProbability: 0,
  failureStage: 'submitted',
  partialFillBps: 10000,
  fees: {
    provenance: 'MODEL',
    selectedBy: 'kill-test',
    networkLamports: '0',
    priorityLamports: '0',
  },
};
/** A quote provider that runs `during` while the buy is in flight, then quotes 1 SOL : 2 tokens. */
function providerDuring(during: () => Promise<void>): PaperQuoteProvider {
  return {
    currentContext: async () => undefined,
    quote: async (request: QuoteRequest) => {
      await during();
      const out = (BigInt(request.inputRaw) * 2n).toString();
      const inputMint = request.intent.side === 'buy' ? SOL : MINT;
      const outputMint = request.intent.side === 'buy' ? MINT : SOL;
      const json = {
        router: 'metis',
        transaction: null,
        inputMint,
        outputMint,
        inAmount: request.inputRaw,
        outAmount: out,
        otherAmountThreshold: out,
        swapMode: 'ExactIn',
        slippageBps: request.intent.maxSlippageBps,
        gasless: false,
        taker: null,
        feeBps: 0,
        feeMint: inputMint,
        platformFee: { amount: '0', feeBps: 0, feeMint: inputMint },
        routePlan: [
          {
            bps: 10000,
            percent: 100,
            swapInfo: {
              ammKey: MINT,
              inputMint,
              outputMint,
              inAmount: request.inputRaw,
              outAmount: out,
            },
          },
        ],
      };
      const now = Date.now();
      return { status: 'available', quote: normalizeJupiterQuote(json, request, now, now, true) };
    },
  };
}

describe.skipIf(!hasTestDatabase)('BOT-16 kill switch and losing-streak breaker', () => {
  const pool = hasTestDatabase ? createTestPool() : undefined!;
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrateUp(pool);
    await pool.query('INSERT INTO tokens(mint,decimals) VALUES($1,9)', [MINT]);
  });
  afterAll(async () => pool.end());

  async function bot(mode: 'paper' | 'off' = 'paper'): Promise<string> {
    const w = (
      await pool.query<{ id: string }>(
        "INSERT INTO wallets(label,public_key) VALUES('kill test',$1) RETURNING id",
        [`P${randomUUID().replaceAll('-', '').replaceAll('0', 'G')}`],
      )
    ).rows[0]!.id;
    return (
      await pool.query<{ id: string }>(
        "INSERT INTO bots(name,strategy,risk_profile_id,wallet_id,mode,paper_bankroll_lamports) VALUES($1,'test','balanced',$2,$3,'1000000000000') RETURNING id",
        [randomUUID(), w, mode],
      )
    ).rows[0]!.id;
  }
  async function order(
    botId: string,
    side: 'buy' | 'sell',
    status = 'pending',
    positionId: string | null = null,
    db: Pick<Pool, 'query'> = pool,
  ) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO orders(id,client_order_id,bot_id,position_id,token_mint,side,mode,status,amount_in_raw,max_slippage_bps,reason,veto_reason)
       VALUES($1,$2,$3,$4,$5,$6,'paper',$7,1000,300,'test',$8)`,
      [
        id,
        `t:${id}`,
        botId,
        positionId,
        MINT,
        side,
        status,
        status === 'vetoed' ? 'kill_switch' : null,
      ],
    );
    return id;
  }
  async function position(botId: string): Promise<string> {
    return (
      await pool.query<{ id: string }>(
        `INSERT INTO positions(bot_id,token_mint,mode,entry_price_sol,quantity_raw,remaining_raw,cost_lamports,stop_price_sol,high_water_price_sol,take_profit_remaining)
         VALUES($1,$2,'paper',1,1000000000,1000000000,1000000000,0.8,1,'[]') RETURNING id`,
        [botId, MINT],
      )
    ).rows[0]!.id;
  }
  function buyIntent(botId: string, orderId: string): ApprovedOrderIntent {
    return {
      orderId,
      clientOrderId: `t:${orderId}`,
      botId,
      positionId: null,
      tokenMint: MINT,
      side: 'buy',
      mode: 'paper',
      amountInRaw: '1000',
      maxSlippageBps: 300,
      expiresAt: Date.now() + 60000,
      approval: { kind: 'manual_paper_scenario', reference: 'kill-test' },
      quoteRequirements: {
        freshnessPolicy: 'bounded_request_age',
        maxAgeMs: 5000,
        maxSlotLag: 20,
        fullyObservedCosts: false,
      },
      entry: { stopPriceSol: '0.000001', takeProfit: [{ atGain: 0.3, sellFraction: 0.5 }] },
      closeReason: null,
    };
  }
  async function activeBuys(): Promise<number> {
    return Number(
      (
        await pool.query<{ n: string }>(
          "SELECT count(*)::text n FROM orders WHERE side='buy' AND status IN ('pending','submitted','partially_filled')",
        )
      ).rows[0]!.n,
    );
  }
  async function alerts(category: string) {
    return (
      await pool.query<{ transition: string; code: string; entity_id: string }>(
        `SELECT e.transition,e.code,i.entity_id FROM monitoring_events e JOIN monitoring_incidents i ON i.id=e.incident_id WHERE i.category=$1 ORDER BY e.id`,
        [category],
      )
    ).rows;
  }

  describe('kill switch', () => {
    it('starts released and cannot be deleted', async () => {
      expect(await getKillSwitch(pool)).toMatchObject({ engaged: false, sellAll: false });
      await expect(pool.query('DELETE FROM kill_switch')).rejects.toThrow(/append-only/);
      await expect(pool.query('INSERT INTO kill_switch DEFAULT VALUES')).rejects.toThrow(
        /duplicate/,
      );
    });

    it('stops buying on every bot, cancels open buys, keeps sells, audits and alerts', async () => {
      const a = await bot(),
        b = await bot(),
        c = await bot('off');
      const buyA = await order(a, 'buy'),
        buyB = await order(b, 'buy', 'partially_filled'),
        posA = await position(a),
        sellA = await order(a, 'sell', 'pending', posA);

      const result = await engageKillSwitch(pool, { actor: 'owner' });
      expect(result).toMatchObject({ engaged: true, sellAll: false, cancelledBuyOrders: 2 });
      expect(result.changedBy).toBe('owner');

      const statuses = (
        await pool.query<{ id: string; status: string; failure_reason: string | null }>(
          'SELECT id,status,failure_reason FROM orders',
        )
      ).rows;
      const byId = Object.fromEntries(statuses.map((r) => [r.id, r]));
      expect(byId[buyA]).toMatchObject({ status: 'cancelled', failure_reason: 'KILL_SWITCH' });
      expect(byId[buyB]).toMatchObject({ status: 'cancelled', failure_reason: 'KILL_SWITCH' });
      expect(byId[sellA]).toMatchObject({ status: 'pending' });

      // Any code path that tries to write a new buy is refused by the database itself.
      for (const id of [a, b, c]) {
        await expect(order(id, 'buy')).rejects.toThrow('KILL_SWITCH_ENGAGED');
        expect(await buyBlockReason(pool, id)).toBe('KILL_SWITCH_ENGAGED');
      }
      // Vetoed buy records and new sells are still allowed.
      await order(a, 'buy', 'vetoed');
      await order(a, 'sell', 'pending', posA);
      // Reopening a cancelled buy is refused too.
      await expect(
        pool.query("UPDATE orders SET status='pending' WHERE id=$1", [buyA]),
      ).rejects.toThrow('KILL_SWITCH_ENGAGED');

      const audit = (
        await pool.query<{ actor: string; action: string }>(
          "SELECT actor,action FROM audit_log WHERE entity_type='kill_switch'",
        )
      ).rows;
      expect(audit).toEqual([{ actor: 'owner', action: 'kill_switch.engaged' }]);
      expect(await alerts('kill_switch')).toEqual([
        { transition: 'opened', code: 'engaged', entity_id: 'global' },
      ]);

      const released = await releaseKillSwitch(pool, { actor: 'owner' });
      expect(released).toMatchObject({ engaged: false, sellAll: false });
      await order(a, 'buy');
      expect(await alerts('kill_switch')).toEqual([
        { transition: 'opened', code: 'engaged', entity_id: 'global' },
        { transition: 'resolved', code: 'engaged', entity_id: 'global' },
      ]);
    });

    it('refuses buy registration and buy execution attempts, whatever the approval', async () => {
      const a = await bot();
      const id = await order(a, 'buy');
      await engageKillSwitch(pool, { actor: 'system' });
      await expect(registerPaperIntent(pool, buyIntent(a, id))).rejects.toThrow(
        'KILL_SWITCH_ENGAGED',
      );
      // Direct attempt writes are refused by the database.
      await expect(
        pool.query(
          `INSERT INTO paper_execution_attempts(order_id,idempotency_key,sequence,input_raw,seed,model,draws,started_at_ms,ready_at_ms)
           VALUES($1,'k',1,1000,'s','{}','{}',0,0)`,
          [id],
        ),
      ).rejects.toThrow('KILL_SWITCH_ENGAGED');
    });

    it('drill: with buyers writing continuously, every bot stops buying within 5 seconds', async () => {
      const bots = await Promise.all(Array.from({ length: 8 }, () => bot()));
      // Its own pool: one connection per buyer plus one for the operator, as in production
      // where the dashboard/CLI does not share connections with the bots.
      const drill = createPool(TEST_DATABASE_URL, { max: bots.length + 2 });
      let stop = false;
      let refusedAfter = 0;
      const buyers = bots.map(async (id) => {
        while (!stop) {
          try {
            await order(id, 'buy', 'pending', null, drill);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'KILL_SWITCH_ENGAGED') throw error;
            refusedAfter++;
          }
        }
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(await activeBuys()).toBeGreaterThan(0);

      let took: number | undefined;
      let failure: unknown;
      try {
        const started = Date.now();
        await engageKillSwitch(drill, { actor: 'owner' });
        took = Date.now() - started;
        // From the moment engage returns, no bot holds an open buy and none can create one.
        expect(await activeBuys()).toBe(0);
        await new Promise((r) => setTimeout(r, 200));
      } catch (error) {
        failure = error;
      }
      stop = true;
      // Always stop the buyers, then surface any unexpected buyer error (such as a deadlock).
      const outcomes = await Promise.allSettled(buyers);
      await drill.end();
      if (failure) throw failure;
      for (const o of outcomes) if (o.status === 'rejected') throw o.reason;
      expect(await activeBuys()).toBe(0);
      expect(refusedAfter).toBeGreaterThan(0);
      expect(took).toBeLessThan(5000);
      process.stdout.write(
        `kill switch drill: engage took ${took} ms with ${bots.length} active buyers\n`,
      );
    }, 20000);

    it('engage is idempotent and can add sell-all; release rejects a stale revision', async () => {
      const first = await engageKillSwitch(pool, { actor: 'owner' });
      const again = await engageKillSwitch(pool, { actor: 'owner' });
      expect(again.revision).toBe(first.revision);
      const sell = await engageKillSwitch(pool, { actor: 'owner', sellAll: true });
      expect(sell).toMatchObject({ engaged: true, sellAll: true });
      expect(await killSwitchSellAll(pool)).toBe(true);
      // Engaging without sellAll never silently turns selling back off.
      expect(await engageKillSwitch(pool, { actor: 'owner' })).toMatchObject({ sellAll: true });
      // Turning sell-all on is its own alert, so the feed learns positions are being sold.
      expect(await alerts('kill_switch')).toEqual([
        { transition: 'opened', code: 'engaged', entity_id: 'global' },
        { transition: 'opened', code: 'sell_all', entity_id: 'sell_all' },
      ]);
      await expect(
        releaseKillSwitch(pool, { actor: 'owner', revision: first.revision }),
      ).rejects.toThrow('KILL_SWITCH_CHANGED');
      await releaseKillSwitch(pool, { actor: 'owner', revision: sell.revision });
      expect((await alerts('kill_switch')).filter((a) => a.transition === 'resolved')).toHaveLength(
        2,
      );
    });

    it('a bot whose lock is busy does not delay the stop for anyone', async () => {
      const busy = await bot(),
        other = await bot();
      const busyBuy = await order(busy, 'buy'),
        otherBuy = await order(other, 'buy');
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [busy]);
        const started = Date.now();
        const result = await engageKillSwitch(pool, { actor: 'owner' });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(result).toMatchObject({
          engaged: true,
          cancelledBuyOrders: 1,
          botsNotYetCleared: 1,
        });
        const status = async (id: string) =>
          (await pool.query('SELECT status FROM orders WHERE id=$1', [id])).rows[0].status;
        expect(await status(otherBuy)).toBe('cancelled');
        // The busy bot's buy is still pending but cannot execute, and no new buy can be written.
        expect(await status(busyBuy)).toBe('pending');
        expect(await buyBlockReason(pool, other)).toBe('KILL_SWITCH_ENGAGED');
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      // Engaging again once the bot is free clears it.
      expect(await engageKillSwitch(pool, { actor: 'owner' })).toMatchObject({
        cancelledBuyOrders: 1,
        botsNotYetCleared: 0,
      });
      expect(await activeBuys()).toBe(0);
    });

    it.each(['kill switch', 'pause'])(
      'a buy already in flight fills nothing when the %s lands mid-execution',
      async (what) => {
        const a = await bot();
        const id = await order(a, 'buy');
        const intent = buyIntent(a, id);
        await registerPaperIntent(pool, intent);
        const n = (
          await pool.query<{ n: number }>(
            "SELECT losing_streak_limit n FROM risk_profiles WHERE id='balanced'",
          )
        ).rows[0]!.n;
        const during =
          what === 'kill switch'
            ? async () => {
                // Flip the switch only (no order cancellation), like a raw or partial engage.
                await pool.query('UPDATE kill_switch SET engaged=true');
              }
            : async () => {
                await withTransaction(pool, async (db) => {
                  await db.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [a]);
                  await db.query('INSERT INTO risk_streaks(bot_id,losses) VALUES($1,$2)', [a, n]);
                });
              };
        const result = await new PaperBroker(pool, providerDuring(during), MODEL).execute(
          intent,
          'k',
        );
        expect(['filled', 'partial']).not.toContain(result.status);
        expect(result.reason).toBe(what === 'kill switch' ? 'KILL_SWITCH_ENGAGED' : 'BOT_PAUSED');
        expect((await pool.query('SELECT * FROM positions WHERE bot_id=$1', [a])).rowCount).toBe(0);
        expect((await pool.query('SELECT * FROM fills')).rowCount).toBe(0);
      },
    );

    it('rollback closes open alerts and records what was removed; re-apply starts clean', async () => {
      const a = await bot();
      await engageKillSwitch(pool, { actor: 'owner', sellAll: true });
      await pool.query(
        `INSERT INTO risk_streaks(bot_id,losses) SELECT $1, losing_streak_limit FROM risk_profiles WHERE id='balanced'`,
        [a],
      );
      await migrateDown(pool, 1);
      const open = await pool.query(
        "SELECT 1 FROM monitoring_incidents WHERE category IN ('kill_switch','losing_streak') AND resolved_at IS NULL",
      );
      expect(open.rowCount).toBe(0);
      const removed = (
        await pool.query<{ details: { wasEngaged: boolean; pausedBots: number } }>(
          "SELECT details FROM audit_log WHERE action='kill_switch.removed_by_rollback'",
        )
      ).rows;
      expect(removed).toEqual([{ details: { wasEngaged: true, sellAll: true, pausedBots: 1 } }]);
      await migrateUp(pool);
      // The bot still has a losing streak at its limit, so re-applying pauses it again.
      expect(await buyBlockReason(pool, a)).toBe('BOT_PAUSED');
      await withTransaction(pool, (db) => resumePausedBot(db, a, 'owner'));
      // A fresh engage emits a fresh 'opened' alert.
      const before = (await alerts('kill_switch')).length;
      await engageKillSwitch(pool, { actor: 'owner' });
      expect((await alerts('kill_switch')).slice(before)).toEqual([
        { transition: 'opened', code: 'engaged', entity_id: 'global' },
      ]);
    });

    it('refuses a buy inserted as filled or reopened while engaged', async () => {
      const a = await bot();
      const done = await order(a, 'buy', 'filled');
      await engageKillSwitch(pool, { actor: 'owner' });
      await expect(order(a, 'buy', 'filled')).rejects.toThrow('KILL_SWITCH_ENGAGED');
      await expect(
        pool.query("UPDATE orders SET status='pending' WHERE id=$1", [done]),
      ).rejects.toThrow('KILL_SWITCH_ENGAGED');
      const p = await position(a);
      const sell = await order(a, 'sell', 'pending', p);
      await expect(pool.query("UPDATE orders SET side='buy' WHERE id=$1", [sell])).rejects.toThrow(
        'KILL_SWITCH_ENGAGED',
      );
    });

    it('sell-all makes the exit manager close the whole position with reason kill_switch', async () => {
      const a = await bot();
      const p = await position(a);
      const decide = async () => {
        await pool.query(
          "UPDATE position_exit_state SET lease_until=NULL,retry_at=clock_timestamp()-interval '1 second' WHERE position_id=$1",
          [p],
        );
        const owner = randomUUID();
        const claimed = await claimExitPosition(pool, p, owner);
        expect(claimed).toBeDefined();
        return decidePositionExit(pool, claimed!, owner);
      };
      // Engaged without sell-all: no forced exit.
      await engageKillSwitch(pool, { actor: 'owner' });
      expect(await decide()).toBeUndefined();
      await engageKillSwitch(pool, { actor: 'owner', sellAll: true });
      const intent = await decide();
      expect(intent).toMatchObject({
        side: 'sell',
        closeReason: 'kill_switch',
        amountInRaw: '1000000000',
        approval: { kind: 'exit_manager' },
      });
    });
  });

  describe('losing-streak breaker', () => {
    async function limit(): Promise<number> {
      return (
        await pool.query<{ n: number }>(
          "SELECT losing_streak_limit n FROM risk_profiles WHERE id='balanced'",
        )
      ).rows[0]!.n;
    }
    async function setStreak(botId: string, losses: number) {
      await withTransaction(pool, async (db) => {
        await db.query('SELECT id FROM bots WHERE id=$1 FOR UPDATE', [botId]);
        await db.query(
          'INSERT INTO risk_streaks(bot_id,losses) VALUES($1,$2) ON CONFLICT(bot_id) DO UPDATE SET losses=EXCLUDED.losses',
          [botId, losses],
        );
      });
    }
    async function pause(botId: string) {
      return (
        await pool.query<{ pause_reason: string | null; paused_at: Date | null }>(
          'SELECT pause_reason,paused_at FROM bots WHERE id=$1',
          [botId],
        )
      ).rows[0]!;
    }

    it('pauses a bot at its limit: no buying, exits continue, audited and alerted', async () => {
      const a = await bot(),
        other = await bot();
      const n = await limit();
      await setStreak(a, n - 1);
      expect((await pause(a)).pause_reason).toBeNull();
      await setStreak(a, n);
      expect((await pause(a)).pause_reason).toBe('losing_streak');

      await expect(order(a, 'buy')).rejects.toThrow('BOT_PAUSED');
      expect(await buyBlockReason(pool, a)).toBe('BOT_PAUSED');
      // Selling and other bots are unaffected.
      const p = await position(a);
      await order(a, 'sell', 'pending', p);
      await order(other, 'buy');

      const audit = (
        await pool.query<{ action: string; details: { losses: number; limit: number } }>(
          "SELECT action,details FROM audit_log WHERE entity_type='bots' AND action='bot.paused'",
        )
      ).rows;
      expect(audit).toEqual([
        { action: 'bot.paused', details: { reason: 'losing_streak', losses: n, limit: n } },
      ]);
      expect(await alerts('losing_streak')).toEqual([
        { transition: 'opened', code: 'streak_limit', entity_id: a },
      ]);

      // A further loss does not re-pause or re-alert.
      await setStreak(a, n + 1);
      expect(await alerts('losing_streak')).toHaveLength(1);
    });

    it('pauses when the limit is lowered below the current streak, at the next loss', async () => {
      const a = await bot();
      await setStreak(a, 2);
      await pool.query("UPDATE risk_profiles SET losing_streak_limit=1 WHERE id='balanced'");
      expect((await pause(a)).pause_reason).toBeNull();
      await setStreak(a, 3);
      expect((await pause(a)).pause_reason).toBe('losing_streak');
    });

    it('owner resume clears the pause, resets the streak and resolves the alert', async () => {
      const a = await bot();
      const n = await limit();
      await setStreak(a, n);
      await expect(resumePausedBot(pool, randomUUID(), 'owner')).rejects.toThrow('BOT_NOT_FOUND');

      const before = (await botControlSnapshot(pool)).bots.find((b) => b.id === a)!;
      expect(before.pauseReason).toBe('losing_streak');
      expect(before.pausedAt).not.toBeNull();
      const resumed = await resumeControlledBot(pool, a, { revision: before.revision });
      expect(resumed).toMatchObject({ pauseReason: null, pausedAt: null });
      expect(
        (await pool.query('SELECT losses FROM risk_streaks WHERE bot_id=$1', [a])).rows[0].losses,
      ).toBe(0);
      await order(a, 'buy');
      expect(await alerts('losing_streak')).toEqual([
        { transition: 'opened', code: 'streak_limit', entity_id: a },
        { transition: 'resolved', code: 'streak_limit', entity_id: a },
      ]);
      await expect(resumeControlledBot(pool, a, { revision: resumed.revision })).rejects.toThrow(
        'BOT_NOT_PAUSED',
      );

      // The breaker works again after a resume.
      await setStreak(a, n);
      expect((await pause(a)).pause_reason).toBe('losing_streak');
    });

    it('a paused bot still cannot buy while the kill switch is released, and vice versa', async () => {
      const a = await bot();
      await setStreak(a, await limit());
      await engageKillSwitch(pool, { actor: 'owner' });
      expect(await buyBlockReason(pool, a)).toBe('KILL_SWITCH_ENGAGED');
      await releaseKillSwitch(pool, { actor: 'owner' });
      expect(await buyBlockReason(pool, a)).toBe('BOT_PAUSED');
      await withTransaction(pool, (db) => resumePausedBot(db, a, 'owner'));
      expect(await buyBlockReason(pool, a)).toBeNull();
    });
  });
});
