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
  /** Bots whose open buys could not be cancelled yet because their lock was busy. They still cannot execute. */
  readonly botsNotYetCleared: number;
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
  if (expected !== actual) throw new KillSwitchError('KILL_SWITCH_CHANGED', 409);
}

function lockTimedOut(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '55P03';
}

/** Longest engage waits for the kill-switch row (writers hold it only for one statement). */
const ENGAGE_LOCK_TIMEOUT = '4s';
/** Longest engage waits for one bot while cancelling its open buys; a busy bot is skipped. */
const CANCEL_LOCK_TIMEOUT = '1s';

/**
 * Stops all buying, in two steps so one busy bot cannot delay the stop for every bot:
 *
 * 1. Flip the switch in a short transaction that locks only the kill-switch row. From the
 *    moment it commits, the database refuses every new buy order and buy attempt, and a
 *    buy attempt already in flight settles with no fill.
 * 2. Cancel open buy orders bot by bot, each under that bot's lock (bot-first lock order).
 *    A bot whose lock is busy is skipped and counted in `botsNotYetCleared`; its open buys
 *    still cannot execute, and the next engage (or the exit check) clears them.
 *
 * Engaging only ever makes things safer, so it takes no revision and is idempotent;
 * it can also turn `sellAll` on, never off.
 */
export async function engageKillSwitch(
  pool: Pool,
  options: { actor: KillSwitchActor; sellAll?: boolean },
): Promise<KillSwitchChange> {
  let state: KillSwitchState;
  try {
    state = await withTransaction(pool, async (db) => {
      await db.query(`SET LOCAL lock_timeout = '${ENGAGE_LOCK_TIMEOUT}'`);
      await setAuditActor(db, options.actor);
      const before = (await db.query<KillSwitchState>(`${STATE} FOR UPDATE`)).rows[0]!;
      const sellAll = before.sellAll || options.sellAll === true;
      await db.query('UPDATE kill_switch SET engaged = true, sell_all = $1', [sellAll]);
      await db.query("SELECT operator_alert('kill_switch', 'global', true, 'engaged')");
      if (sellAll)
        await db.query("SELECT operator_alert('kill_switch', 'sell_all', true, 'sell_all')");
      return getKillSwitch(db);
    });
  } catch (error) {
    if (lockTimedOut(error)) throw new KillSwitchError('KILL_SWITCH_BUSY', 503);
    throw error;
  }
  const bots = (
    await pool.query<{ bot_id: string }>(
      `SELECT DISTINCT bot_id FROM orders WHERE side = 'buy' AND status IN ('pending','submitted','partially_filled') ORDER BY bot_id`,
    )
  ).rows;
  let cancelled = 0,
    skipped = 0;
  for (const { bot_id } of bots) {
    try {
      cancelled += await withTransaction(pool, async (db) => {
        await db.query(`SET LOCAL lock_timeout = '${CANCEL_LOCK_TIMEOUT}'`);
        await setAuditActor(db, options.actor);
        await db.query('SELECT id FROM bots WHERE id = $1 FOR UPDATE', [bot_id]);
        await db.query(
          `SELECT id FROM orders WHERE bot_id = $1 AND side = 'buy' AND status IN ('pending','submitted','partially_filled') ORDER BY id FOR UPDATE`,
          [bot_id],
        );
        const result = await db.query(
          `UPDATE orders SET status = 'cancelled', failure_reason = 'KILL_SWITCH'
            WHERE bot_id = $1 AND side = 'buy' AND status IN ('pending','submitted','partially_filled')`,
          [bot_id],
        );
        return result.rowCount ?? 0;
      });
    } catch (error) {
      if (!lockTimedOut(error)) throw error;
      skipped++;
    }
  }
  return { ...state, cancelledBuyOrders: cancelled, botsNotYetCleared: skipped };
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
    await db.query("SELECT operator_alert('kill_switch', 'sell_all', false, 'sell_all')");
    const state = await getKillSwitch(db);
    return { ...state, cancelledBuyOrders: 0, botsNotYetCleared: 0 };
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
