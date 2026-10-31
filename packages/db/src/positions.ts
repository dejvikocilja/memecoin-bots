import type { RiskProfileName, TakeProfitStep } from '@memebots/core';

import type { Queryable } from './pool.js';

/**
 * Everything the engine needs to resume watching an open position after a
 * restart: the position itself, its bot and the bot's risk profile.
 *
 * Raw amounts and lamports are `bigint`. Prices and fractions are decimal
 * strings, exactly as stored, so nothing is rounded on the way out.
 */
export interface OpenPosition {
  readonly id: string;
  readonly botId: string;
  readonly botName: string;
  readonly strategy: string;
  readonly mode: 'paper' | 'live';
  readonly tokenMint: string;
  readonly tokenDecimals: number;
  readonly openedAt: Date;
  readonly entryPriceSol: string;
  readonly quantityRaw: bigint;
  readonly remainingRaw: bigint;
  readonly costLamports: bigint;
  readonly stopPriceSol: string;
  readonly highWaterPriceSol: string;
  readonly takeProfitRemaining: readonly TakeProfitStep[];
  readonly realizedPnlLamports: bigint;
  readonly riskProfile: {
    readonly id: RiskProfileName | string;
    readonly trailingStopFraction: string | null;
    readonly maxHoldMinutes: number;
  };
}

interface OpenPositionRow {
  id: string;
  bot_id: string;
  bot_name: string;
  strategy: string;
  mode: 'paper' | 'live';
  token_mint: string;
  decimals: number;
  opened_at: Date;
  entry_price_sol: string;
  quantity_raw: string;
  remaining_raw: string;
  cost_lamports: string;
  stop_price_sol: string;
  high_water_price_sol: string;
  take_profit_remaining: TakeProfitStep[];
  realized_pnl_lamports: string;
  risk_profile_id: string;
  trailing_stop_fraction: string | null;
  max_hold_minutes: number;
}

/** Loads every open position (optionally for one bot), oldest first. */
export async function loadOpenPositions(
  db: Queryable,
  options: { botId?: string } = {},
): Promise<OpenPosition[]> {
  const { rows } = await db.query<OpenPositionRow>(
    `SELECT p.id, p.bot_id, b.name AS bot_name, b.strategy, p.mode, p.token_mint, t.decimals,
            p.opened_at, p.entry_price_sol, p.quantity_raw, p.remaining_raw, p.cost_lamports,
            p.stop_price_sol, p.high_water_price_sol, p.take_profit_remaining, p.realized_pnl_lamports,
            rp.id AS risk_profile_id, rp.trailing_stop_fraction, rp.max_hold_minutes
       FROM positions p
       JOIN bots b ON b.id = p.bot_id
       JOIN tokens t ON t.mint = p.token_mint
       JOIN risk_profiles rp ON rp.id = b.risk_profile_id
      WHERE p.status = 'open' AND ($1::uuid IS NULL OR p.bot_id = $1::uuid)
      ORDER BY p.opened_at, p.id`,
    [options.botId ?? null],
  );

  return rows.map((r) => ({
    id: r.id,
    botId: r.bot_id,
    botName: r.bot_name,
    strategy: r.strategy,
    mode: r.mode,
    tokenMint: r.token_mint,
    tokenDecimals: r.decimals,
    openedAt: r.opened_at,
    entryPriceSol: r.entry_price_sol,
    quantityRaw: BigInt(r.quantity_raw),
    remainingRaw: BigInt(r.remaining_raw),
    costLamports: BigInt(r.cost_lamports),
    stopPriceSol: r.stop_price_sol,
    highWaterPriceSol: r.high_water_price_sol,
    takeProfitRemaining: r.take_profit_remaining,
    realizedPnlLamports: BigInt(r.realized_pnl_lamports),
    riskProfile: {
      id: r.risk_profile_id,
      trailingStopFraction: r.trailing_stop_fraction,
      maxHoldMinutes: r.max_hold_minutes,
    },
  }));
}
