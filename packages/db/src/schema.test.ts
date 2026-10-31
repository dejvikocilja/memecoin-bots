import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { recordAudit } from './audit.js';
import { migrateUp } from './migrate.js';
import { createPool } from './pool.js';
import { loadOpenPositions } from './positions.js';
import { TEST_DATABASE_URL, createTestPool, hasTestDatabase, resetDatabase } from './test-db.js';

const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

describe.skipIf(!hasTestDatabase)('schema', () => {
  const pool = hasTestDatabase ? createTestPool() : undefined!;

  // fills and audit_log refuse deletes, so each test starts from a freshly migrated database.
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrateUp(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seed(): Promise<{ botId: string; otherBotId: string }> {
    await pool.query(`
      INSERT INTO risk_profiles (id, display_name, position_fraction, stop_loss_fraction, take_profit_ladder,
        trailing_stop_fraction, min_reward_risk, max_open_positions, daily_loss_limit_fraction,
        max_slippage_bps, min_liquidity_usd, min_safety_score, max_hold_minutes, losing_streak_limit)
      VALUES ('balanced', 'Balanced', 0.02, 0.20, '[{"atGain":0.3,"sellFraction":0.4},{"atGain":0.6,"sellFraction":0.3}]',
        0.15, 2, 5, 0.06, 300, 50000, 60, 720, 4)
      ON CONFLICT (id) DO UPDATE SET max_hold_minutes = 720`);
    await pool.query(
      `INSERT INTO tokens (mint, symbol, decimals) VALUES ($1, 'AAA', 6), ($2, 'BBB', 5)`,
      [MINT_A, MINT_B],
    );
    const bot = await pool.query<{ id: string }>(
      `INSERT INTO bots (name, strategy, risk_profile_id, paper_bankroll_lamports)
       VALUES ('momentum-balanced', 'momentum', 'balanced', 10000000000) RETURNING id`,
    );
    const other = await pool.query<{ id: string }>(
      `INSERT INTO bots (name, strategy, risk_profile_id) VALUES ('dip-balanced', 'dip_buy', 'balanced') RETURNING id`,
    );
    return { botId: bot.rows[0]!.id, otherBotId: other.rows[0]!.id };
  }

  async function openPosition(botId: string, mint: string, overrides: Record<string, string> = {}) {
    const values = {
      entry: '0.000001234567890123',
      qty: '123456789012345678901234',
      remaining: '100000000000000000000000',
      cost: '152415787',
      stop: '0.000000987654312098',
      high: '0.0000015',
      ...overrides,
    };
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO positions (bot_id, token_mint, mode, entry_price_sol, quantity_raw, remaining_raw,
         cost_lamports, stop_price_sol, high_water_price_sol, take_profit_remaining)
       VALUES ($1, $2, 'paper', $3, $4, $5, $6, $7, $8, '[{"atGain":0.6,"sellFraction":0.3}]') RETURNING id`,
      [
        botId,
        mint,
        values.entry,
        values.qty,
        values.remaining,
        values.cost,
        values.stop,
        values.high,
      ],
    );
    return rows[0]!.id;
  }

  describe('restart', () => {
    it('rebuilds every open position, exactly, from a fresh connection', async () => {
      const { botId, otherBotId } = await seed();
      const first = await openPosition(botId, MINT_A);
      const second = await openPosition(otherBotId, MINT_B, { remaining: '5', qty: '10' });
      const closed = await openPosition(botId, MINT_B);
      await pool.query(
        `UPDATE positions SET status = 'closed', closed_at = now(), close_reason = 'stop_loss', remaining_raw = 0 WHERE id = $1`,
        [closed],
      );

      // Simulate a restart: a brand-new pool with nothing carried over in memory.
      const fresh = createPool(TEST_DATABASE_URL, { max: 1 });
      try {
        const open = await loadOpenPositions(fresh);
        expect(open.map((p) => p.id)).toEqual([first, second]);

        const p = open[0]!;
        expect(p).toMatchObject({
          botId,
          botName: 'momentum-balanced',
          strategy: 'momentum',
          mode: 'paper',
          tokenMint: MINT_A,
          tokenDecimals: 6,
          entryPriceSol: '0.000001234567890123',
          quantityRaw: 123456789012345678901234n,
          remainingRaw: 100000000000000000000000n,
          costLamports: 152415787n,
          stopPriceSol: '0.000000987654312098',
          highWaterPriceSol: '0.0000015',
          realizedPnlLamports: 0n,
          takeProfitRemaining: [{ atGain: 0.6, sellFraction: 0.3 }],
          riskProfile: { id: 'balanced', trailingStopFraction: '0.15', maxHoldMinutes: 720 },
        });
        expect(p.openedAt).toBeInstanceOf(Date);

        expect((await loadOpenPositions(fresh, { botId: otherBotId })).map((x) => x.id)).toEqual([
          second,
        ]);
      } finally {
        await fresh.end();
      }
    });
  });

  describe('rules the database enforces', () => {
    it('caps position size at 5% for every profile', async () => {
      await expect(
        pool.query(`
          INSERT INTO risk_profiles (id, display_name, position_fraction, stop_loss_fraction, min_reward_risk,
            max_open_positions, daily_loss_limit_fraction, max_slippage_bps, min_liquidity_usd, min_safety_score,
            max_hold_minutes, losing_streak_limit, take_profit_ladder)
          VALUES ('yolo', 'Yolo', 0.25, 0.5, 5, 10, 0.2, 1000, 0, 10, 60, 3,
            '[{"atGain":1,"sellFraction":1}]')`),
      ).rejects.toThrow(/position_fraction/);
    });

    it('will not let a bot go live without a wallet', async () => {
      const { botId } = await seed();
      await expect(
        pool.query(`UPDATE bots SET mode = 'live' WHERE id = $1`, [botId]),
      ).rejects.toThrow(/live_bot_needs_wallet/);
      const w = await pool.query<{ id: string }>(
        `INSERT INTO wallets (label, public_key) VALUES ('hot-1', $1) RETURNING id`,
        [WALLET],
      );
      await pool.query(`UPDATE bots SET mode = 'live', wallet_id = $2 WHERE id = $1`, [
        botId,
        w.rows[0]!.id,
      ]);
    });

    it('gives each wallet to at most one bot', async () => {
      const { botId, otherBotId } = await seed();
      const w = await pool.query<{ id: string }>(
        `INSERT INTO wallets (label, public_key) VALUES ('hot-1', $1) RETURNING id`,
        [WALLET],
      );
      await pool.query(`UPDATE bots SET wallet_id = $2 WHERE id = $1`, [botId, w.rows[0]!.id]);
      await expect(
        pool.query(`UPDATE bots SET wallet_id = $2 WHERE id = $1`, [otherBotId, w.rows[0]!.id]),
      ).rejects.toThrow(/unique/i);
    });

    it('allows one open position per bot and token', async () => {
      const { botId } = await seed();
      await openPosition(botId, MINT_A);
      await expect(openPosition(botId, MINT_A)).rejects.toThrow(/positions_one_open_per_bot_token/);
    });

    it('requires a closed position to be fully sold and say why', async () => {
      const { botId } = await seed();
      const id = await openPosition(botId, MINT_A);
      await expect(
        pool.query(`UPDATE positions SET status = 'closed', closed_at = now() WHERE id = $1`, [id]),
      ).rejects.toThrow(/closed_positions_are_complete/);
    });

    it('requires vetoed orders to give a reason', async () => {
      const { botId } = await seed();
      await expect(
        pool.query(
          `INSERT INTO orders (client_order_id, bot_id, token_mint, side, mode, status, amount_in_raw, max_slippage_bps, reason)
           VALUES ('o-1', $1, $2, 'buy', 'paper', 'vetoed', 1000, 300, 'breakout')`,
          [botId, MINT_A],
        ),
      ).rejects.toThrow(/vetoed_orders_say_why/);
    });

    it('keeps fills append-only and traceable', async () => {
      const { botId } = await seed();
      const order = await pool.query<{ id: string }>(
        `INSERT INTO orders (client_order_id, bot_id, token_mint, side, mode, status, amount_in_raw, max_slippage_bps, reason)
         VALUES ('o-2', $1, $2, 'buy', 'paper', 'filled', 1000000, 300, 'breakout') RETURNING id`,
        [botId, MINT_A],
      );
      const orderId = order.rows[0]!.id;
      const insertFill = (mode: string, signature: string | null, wallet: string | null) =>
        pool.query<{ id: string }>(
          `INSERT INTO fills (order_id, token_mint, mode, executed_at, token_amount_raw, sol_amount_lamports,
             price_sol, wallet_public_key, tx_signature)
           VALUES ($1, $2, $3, now(), 810000, 1000000, 0.00000123, $4, $5) RETURNING id`,
          [orderId, MINT_A, mode, wallet, signature],
        );

      await expect(insertFill('paper', 'sig', null)).rejects.toThrow(/live_fills_are_traceable/);
      await expect(insertFill('live', null, WALLET)).rejects.toThrow(/live_fills_are_traceable/);

      const fill = await insertFill('paper', null, null);
      const fillId = fill.rows[0]!.id;
      await expect(
        pool.query(`UPDATE fills SET price_sol = 1 WHERE id = $1`, [fillId]),
      ).rejects.toThrow(/append-only/);
      await expect(pool.query(`DELETE FROM fills WHERE id = $1`, [fillId])).rejects.toThrow(
        /append-only/,
      );
      await expect(pool.query(`TRUNCATE fills CASCADE`)).rejects.toThrow(/append-only/);
    });

    it('keeps the audit log append-only', async () => {
      await recordAudit(pool, {
        actor: 'owner',
        action: 'bot.mode_changed',
        entityType: 'bot',
        entityId: 'b-1',
        details: { from: 'paper', to: 'off' },
      });
      const { rows } = await pool.query<{ action: string; details: unknown }>(
        'SELECT action, details FROM audit_log',
      );
      expect(rows).toEqual([{ action: 'bot.mode_changed', details: { from: 'paper', to: 'off' } }]);

      await expect(pool.query(`UPDATE audit_log SET actor = 'someone else'`)).rejects.toThrow(
        /append-only/,
      );
      await expect(pool.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
    });

    it('never stores private keys: wallets hold a public key only', async () => {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'wallets' ORDER BY ordinal_position`,
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        'id',
        'label',
        'public_key',
        'spend_cap_lamports',
        'created_at',
      ]);
    });
  });
});
