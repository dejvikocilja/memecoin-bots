import { RISK_PROFILE_FIELDS, isProfileObject, validateRiskProfile } from '@memebots/core';
import type { RiskProfile, RiskProfileConfig } from '@memebots/core';

import { recordAudit } from './audit.js';
import { withTransaction } from './pool.js';
import type { Pool, Queryable } from './pool.js';

const columns = {
  displayName: 'display_name',
  positionFraction: 'position_fraction',
  stopLossFraction: 'stop_loss_fraction',
  takeProfitLadder: 'take_profit_ladder',
  trailingStopFraction: 'trailing_stop_fraction',
  minRewardRisk: 'min_reward_risk',
  maxOpenPositions: 'max_open_positions',
  dailyLossLimitFraction: 'daily_loss_limit_fraction',
  maxSlippageBps: 'max_slippage_bps',
  minLiquidityUsd: 'min_liquidity_usd',
  minSafetyScore: 'min_safety_score',
  maxHoldMinutes: 'max_hold_minutes',
  losingStreakLimit: 'losing_streak_limit',
  safetyMode: 'safety_mode',
} as const satisfies Record<keyof RiskProfileConfig, string>;

const select = `id, revision::text, ${RISK_PROFILE_FIELDS.map((key) => `${columns[key]} AS "${key}"`).join(', ')}`;
const selectForEdit = `${select}, take_profit_ladder::text AS "ladderJson"`;
type ProfileForEdit = RiskProfile & { readonly ladderJson: string };

export async function listRiskProfiles(db: Queryable): Promise<RiskProfile[]> {
  return (await db.query<RiskProfile>(`SELECT ${select} FROM risk_profiles ORDER BY id`)).rows;
}

export async function getRiskProfile(db: Queryable, id: string): Promise<RiskProfile | null> {
  return (
    (await db.query<RiskProfile>(`SELECT ${select} FROM risk_profiles WHERE id = $1`, [id]))
      .rows[0] ?? null
  );
}

export class RiskProfileConflictError extends Error {
  constructor() {
    super('Risk profile changed; reload it before editing');
    this.name = 'RiskProfileConflictError';
  }
}

/** Atomic partial edit. Every writer increments revision, including direct SQL writers. */
export async function updateRiskProfile(
  pool: Pool,
  id: string,
  changes: unknown,
  options: { expectedRevision: string; actor: string },
): Promise<RiskProfile> {
  if (
    !isProfileObject(changes) ||
    Object.keys(changes).length === 0 ||
    Object.keys(changes).some((key) => !(RISK_PROFILE_FIELDS as readonly string[]).includes(key))
  ) {
    throw new Error('Risk profile changes must contain only editable policy fields');
  }
  if (
    !/^[1-9]\d{0,18}$/.test(options.expectedRevision) ||
    options.actor.trim() === '' ||
    options.actor.length > 100
  ) {
    throw new Error('A revision and bounded nonempty actor are required');
  }
  return withTransaction(pool, async (db) => {
    const before = (
      await db.query<ProfileForEdit>(
        `SELECT ${selectForEdit} FROM risk_profiles WHERE id = $1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!before) throw new Error('Risk profile not found');
    if (before.revision !== options.expectedRevision) throw new RiskProfileConflictError();
    const config = Object.fromEntries(RISK_PROFILE_FIELDS.map((key) => [key, before[key]]));
    const merged = { ...config, ...changes };
    const errors = validateRiskProfile(merged);
    if (errors.length > 0) throw new Error(`Invalid risk profile: ${errors.join('; ')}`);
    // Only write explicit mutations. Re-serializing an untouched JSON ladder would
    // round any legacy PostgreSQL numeric precision through JavaScript numbers.
    const changedFields = RISK_PROFILE_FIELDS.filter((key) => Object.hasOwn(changes, key));
    const values = changedFields.map((key) =>
      key === 'takeProfitLadder' ? JSON.stringify(merged[key]) : merged[key],
    );
    const assignments = changedFields
      .map((key, index) => `${columns[key]} = $${index + 2}`)
      .join(', ');
    const after = (
      await db.query<ProfileForEdit>(
        `UPDATE risk_profiles SET ${assignments} WHERE id = $1 RETURNING ${selectForEdit}`,
        [id, ...values],
      )
    ).rows[0]!;
    // Public policy only: omit free-form display name; never copy arbitrary input.
    const policy = (profile: ProfileForEdit) =>
      Object.fromEntries(
        RISK_PROFILE_FIELDS.filter((key) => key !== 'displayName').map((key) => [
          key,
          key === 'takeProfitLadder'
            ? profile.ladderJson.length <= 32768
              ? profile.ladderJson
              : '[omitted: exceeds audit ladder bound]'
            : typeof profile[key] === 'string' && profile[key].length > 80
              ? '[omitted: exceeds policy input bound]'
              : profile[key],
        ]),
      );
    await recordAudit(db, {
      actor: options.actor,
      action: 'risk_profile.edit_applied',
      entityType: 'risk_profile',
      entityId: id,
      details: {
        previousRevision: before.revision,
        revision: after.revision,
        before: policy(before),
        after: policy(after),
      },
    });
    // The exact SQL JSON representation is audit metadata, not a DTO field.
    return Object.fromEntries([
      ['id', after.id],
      ['revision', after.revision],
      ...RISK_PROFILE_FIELDS.map((key) => [key, after[key]]),
    ]) as unknown as RiskProfile;
  });
}
