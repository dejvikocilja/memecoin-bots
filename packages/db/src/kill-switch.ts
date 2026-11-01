import type { KillSwitchStatus } from '@memebots/core';

import { recordAudit, setAuditActor } from './audit.js';
import { withTransaction } from './pool.js';
import type { Pool, Queryable } from './pool.js';

/**
 * BOT-16: global kill switch and losing-streak breaker.
 *
 * The kill switch stops all buying on every bot at once. It never blocks selling:
 * stops, take-profits and other exits keep running. With `sellAll`, the exit manager
 * also closes every open paper position (close reason `kill_switch`).
 *
 * The database enforces it (migration 0016): while engaged, no new buy order or buy
 * execution attempt can be written, whatever code path tries.
 */
export type KillSwitchState = KillSwitchStatus;

export interface KillSwitchChange extends KillSwitchState {
  /** Buy orders cancelled by this change (engage only). */
  readonly cancelledBuyOrders: number;
}

export type KillSwitchActor = 'owner' | 'system';

export class KillSwitchError extends Error {
  constructor(
    readonly code: string,
    readonly status: number = 400,
  ) {
    super(code);
  }
}

export const BUY_BLOCK_CODES = ['KILL_SWITCH_ENGAGED', 'BOT_PAUSED'] as const;
export type BuyBlockCode = (typeof BUY_BLOCK_CODES)[number];

const STATE = `SELECT engaged, sell_all AS "sellAll", revision::text AS revision,
  changed_at::text AS "changedAt", changed_by AS "changedBy" FROM kill_switch`;

export async function getKillSwitch(db: Queryable): Promise<KillSwitchState> {
  const row = (await db.query<KillSwitchState>(STATE)).rows[0];
  if (!row) throw new KillSwitchError('KILL_SWITCH_MISSING', 503);
  return row;
}

/** Why a buy for this bot may not proceed right now, or null. Same rule the database enforces. */
export async function buyBlockReason(db: Queryable, botId: string): Promise<BuyBlockCode | null> {
  const row = (
    await db.query<{ reason: BuyBlockCode | null }>('SELECT buy_block_reason($1::uuid) AS reason', [
      botId,
    ])
  ).rows[0];
  return row?.reason ?? null;
}

/** True when the exit manager should close every open paper position. */
export async function killSwitchSellAll(db: Queryable): Promise<boolean> {
  return (
    (await db.query<{ v: boolean }>('SELECT (engaged AND sell_all) AS v FROM kill_switch')).rows[0]
      ?.v ?? false
  );
}

function checkRevision(expected: string | undefined, actual: string): void {
  if (expected === undefined) return;
  if (!/^[1-9][0-9]{0,18}$/.test(expected)) throw new KillSwitchError('INVALID_REVISION');
  if (expected !== actual) throw new KillSwitchError('STALE_REVISION', 409);
}

/**
 * Stops all buying. In one transaction: lock every bot (bot-first lock order), flip the
 * switch, cancel every open buy order across all bots, audit and raise an alert.
 * Calling it again while engaged is safe; it can also turn `sellAll` on.
 */
export async function engageKillSwitch(
  pool: Pool,
  options: { actor: KillSwitchActor; sellAll?: boolean; revision?: string },
): Promise<KillSwitchChange> {
  return withTransaction(pool, async (db) => {
    await setAuditActor(db, options.actor);
    await db.query('SELECT id FROM bots ORDER BY id FOR UPDATE');
    const before = (await db.query<KillSwitchState>(`${STATE} FOR UPDATE`)).rows[0]!;
    checkRevision(options.revision, before.revision);
    const sellAll = before.engaged ? before.sellAll || options.sellAll === true : !!options.sellAll;
    await db.query('UPDATE kill_switch SET engaged = true, sell_all = $1', [sellAll]);
    await db.query(
      `SELECT id FROM orders WHERE side = 'buy' AND status IN ('pending','submitted','partially_filled') ORDER BY id FOR UPDATE`,
    );
    const cancelled = await db.query(
      `UPDATE orders SET status = 'cancelled', failure_reason = 'KILL_SWITCH'
        WHERE side = 'buy' AND status IN ('pending','submitted','partially_filled')`,
    );
    await db.query("SELECT operator_alert('kill_switch', 'global', true, $1)", [
      sellAll ? 'sell_all' : 'engaged',
    ]);
    const state = await getKillSwitch(db);
    return { ...state, cancelledBuyOrders: cancelled.rowCount ?? 0 };
  });
}

/** Lets bots buy again. Bots keep their own mode; paused bots stay paused. */
export async function releaseKillSwitch(
  pool: Pool,
  options: { actor: KillSwitchActor; revision?: string },
): Promise<KillSwitchChange> {
  return withTransaction(pool, async (db) => {
    await setAuditActor(db, options.actor);
    const before = (await db.query<KillSwitchState>(`${STATE} FOR UPDATE`)).rows[0]!;
    checkRevision(options.revision, before.revision);
    await db.query('UPDATE kill_switch SET engaged = false, sell_all = false');
    await db.query("SELECT operator_alert('kill_switch', 'global', false, 'engaged')");
    const state = await getKillSwitch(db);
    return { ...state, cancelledBuyOrders: 0 };
  });
}

/**
 * The owner acknowledges a losing streak and lets the bot buy again: clears the pause,
 * resets the streak to zero, audits and resolves the alert.
 */
export async function resumePausedBot(
  db: Queryable,
  botId: string,
  actor: KillSwitchActor,
): Promise<void> {
  await setAuditActor(db, actor);
  const bot = (
    await db.query<{ pause_reason: string | null }>(
      'SELECT pause_reason FROM bots WHERE id = $1 FOR UPDATE',
      [botId],
    )
  ).rows[0];
  if (!bot) throw new KillSwitchError('BOT_NOT_FOUND', 404);
  if (bot.pause_reason === null) throw new KillSwitchError('BOT_NOT_PAUSED', 409);
  const streak = (
    await db.query<{ losses: number }>('SELECT losses FROM risk_streaks WHERE bot_id = $1', [botId])
  ).rows[0]?.losses;
  await db.query('UPDATE bots SET paused_at = NULL, pause_reason = NULL WHERE id = $1', [botId]);
  await db.query('UPDATE risk_streaks SET losses = 0 WHERE bot_id = $1', [botId]);
  await recordAudit(db, {
    actor,
    action: 'bot.resumed',
    entityType: 'bots',
    entityId: botId,
    details: { reason: bot.pause_reason, lossesCleared: streak ?? 0 },
  });
  await db.query("SELECT operator_alert('losing_streak', $1, false, 'streak_limit')", [botId]);
}
