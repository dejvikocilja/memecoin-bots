import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateDown, migrateUp, migrationStatus } from './migrate.js';
import { createPool } from './pool.js';
import {
  getRiskProfile,
  listRiskProfiles,
  RiskProfileConflictError,
  updateRiskProfile,
} from './risk-profiles.js';
import { TEST_DATABASE_URL, createTestPool, hasTestDatabase, resetDatabase } from './test-db.js';

describe.skipIf(!hasTestDatabase)('editable risk profiles', () => {
  const pool = hasTestDatabase ? createTestPool() : undefined!;
  beforeEach(async () => {
    await resetDatabase(pool);
    await migrateUp(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('seeds every exact specification value and documented engineering default', async () => {
    const profiles = await listRiskProfiles(pool);
    expect(profiles).toHaveLength(4);
    const expected = [
      [
        'conservative',
        'Conservative',
        '0.01',
        '0.10',
        [{ atGain: 0.15, sellFraction: 0.5 }],
        '0.08',
        '1.5',
        3,
        '0.03',
        'strict',
        100,
        '100000',
        85,
        240,
        3,
      ],
      [
        'balanced',
        'Balanced',
        '0.02',
        '0.20',
        [
          { atGain: 0.3, sellFraction: 0.4 },
          { atGain: 0.6, sellFraction: 0.3 },
        ],
        '0.15',
        '2',
        5,
        '0.06',
        'standard',
        200,
        '50000',
        75,
        360,
        4,
      ],
      [
        'aggressive',
        'Aggressive',
        '0.04',
        '0.35',
        [
          { atGain: 1, sellFraction: 0.3 },
          { atGain: 2, sellFraction: 0.3 },
        ],
        '0.25',
        '3',
        8,
        '0.12',
        'standard',
        300,
        '25000',
        65,
        240,
        5,
      ],
      [
        'degen',
        'Degen',
        '0.05',
        '0.50',
        [
          { atGain: 1, sellFraction: 0.25 },
          { atGain: 4, sellFraction: 0.25 },
        ],
        '0.40',
        '5',
        10,
        '0.20',
        'relaxed',
        500,
        '10000',
        55,
        120,
        5,
      ],
    ];
    for (const [
      id,
      displayName,
      positionFraction,
      stopLossFraction,
      takeProfitLadder,
      trailingStopFraction,
      minRewardRisk,
      maxOpenPositions,
      dailyLossLimitFraction,
      safetyMode,
      maxSlippageBps,
      minLiquidityUsd,
      minSafetyScore,
      maxHoldMinutes,
      losingStreakLimit,
    ] of expected) {
      expect(profiles.find((p) => p.id === id)).toEqual({
        id,
        displayName,
        positionFraction,
        stopLossFraction,
        takeProfitLadder,
        trailingStopFraction,
        minRewardRisk,
        maxOpenPositions,
        dailyLossLimitFraction,
        safetyMode,
        maxSlippageBps,
        minLiquidityUsd,
        minSafetyScore,
        maxHoldMinutes,
        losingStreakLimit,
        revision: '1',
      });
    }
    expect(await getRiskProfile(pool, 'missing')).toBeNull();
  });

  it('persists an exact partial edit with bounded public audit across restart', async () => {
    const after = await updateRiskProfile(
      pool,
      'balanced',
      { positionFraction: '0.0200000000000000000001', displayName: 'Owner choice' },
      { expectedRevision: '1', actor: 'owner' },
    );
    expect(after.revision).toBe('2');
    const fresh = createPool(TEST_DATABASE_URL);
    try {
      expect(await getRiskProfile(fresh, 'balanced')).toEqual(after);
    } finally {
      await fresh.end();
    }
    const { rows } = await pool.query<{
      actor: string;
      action: string;
      details: Record<string, unknown>;
    }>('SELECT actor, action, details FROM audit_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'owner',
      action: 'risk_profile.edit_applied',
      details: {
        previousRevision: '1',
        revision: '2',
        after: { positionFraction: '0.0200000000000000000001' },
      },
    });
    expect(JSON.stringify(rows)).not.toContain('Owner choice');
  });

  it('allows only one concurrent editor with the same revision', async () => {
    const outcomes = await Promise.allSettled(
      ['0.01', '0.03'].map((positionFraction) =>
        updateRiskProfile(
          pool,
          'balanced',
          { positionFraction },
          { expectedRevision: '1', actor: 'owner' },
        ),
      ),
    );
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(
      RiskProfileConflictError,
    );
    expect((await pool.query('SELECT * FROM audit_log')).rowCount).toBe(1);
  });

  it('bounds audit data when repairing an oversized legacy decimal', async () => {
    await pool.query("UPDATE risk_profiles SET min_liquidity_usd = $1 WHERE id = 'balanced'", [
      '1'.repeat(100),
    ]);
    await updateRiskProfile(
      pool,
      'balanced',
      { minLiquidityUsd: '50000' },
      { expectedRevision: '2', actor: 'owner' },
    );
    const { rows } = await pool.query<{ details: { before: { minLiquidityUsd: string } } }>(
      'SELECT details FROM audit_log',
    );
    expect(rows[0]?.details.before.minLiquidityUsd).toBe('[omitted: exceeds policy input bound]');
  });

  it('rejects invalid, unknown and stale edits without changing policy or audit', async () => {
    for (const changes of [
      { positionFraction: '0.050000000000000001' },
      { takeProfitLadder: [] },
      { trailingStopFraction: null },
      { safetyMode: 'off' },
      { minSafetyScore: 0 },
      { id: 'degen' },
      {},
      null,
    ]) {
      await expect(
        updateRiskProfile(pool, 'balanced', changes, { expectedRevision: '1', actor: 'owner' }),
      ).rejects.toThrow();
    }
    await pool.query("UPDATE risk_profiles SET max_hold_minutes = 361 WHERE id = 'balanced'");
    await expect(
      updateRiskProfile(
        pool,
        'balanced',
        { maxHoldMinutes: 362 },
        { expectedRevision: '1', actor: 'owner' },
      ),
    ).rejects.toBeInstanceOf(RiskProfileConflictError);
    expect((await getRiskProfile(pool, 'balanced'))?.maxHoldMinutes).toBe(361);
    expect((await pool.query('SELECT * FROM audit_log')).rowCount).toBe(0);
  });

  it('rolls policy and revision back when its audit cannot be persisted', async () => {
    await pool.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END; $$;
      CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()`);
    await expect(
      updateRiskProfile(
        pool,
        'balanced',
        { maxHoldMinutes: 400 },
        { expectedRevision: '1', actor: 'owner' },
      ),
    ).rejects.toThrow(/audit unavailable/);
    expect(await getRiskProfile(pool, 'balanced')).toMatchObject({
      maxHoldMinutes: 360,
      revision: '1',
    });
  });

  it.each([
    'position_fraction = 0.0500000000000000000001',
    "min_reward_risk = 'NaN'",
    "min_liquidity_usd = 'Infinity'",
    'max_slippage_bps = 5001',
    'min_safety_score = 0',
    'max_hold_minutes = 0',
    'losing_streak_limit = 0',
    "safety_mode = 'off'",
    "take_profit_ladder = '[]'",
    "take_profit_ladder = '[null]'",
    'take_profit_ladder = \'[{"atGain":1e400,"sellFraction":0.5}]\'',
    'take_profit_ladder = \'[{"atGain":1e-400,"sellFraction":0.5}]\'',
    'take_profit_ladder = \'[{"atGain":1,"sellFraction":0.7},{"atGain":1,"sellFraction":0.2}]\'',
    'take_profit_ladder = \'[{"atGain":1,"sellFraction":0.7},{"atGain":2,"sellFraction":0.4}]\'',
    'take_profit_ladder = \'[{"atGain":1,"sellFraction":"0.5"}]\'',
    'trailing_stop_fraction = NULL',
  ])('database rejects bypass attempts: %s', async (assignment) => {
    await expect(
      pool.query(`UPDATE risk_profiles SET ${assignment} WHERE id = 'degen'`),
    ).rejects.toThrow();
  });

  it('migration retry and down/up preserve numeric owner edits and bot references', async () => {
    await updateRiskProfile(
      pool,
      'balanced',
      { minLiquidityUsd: '123456.1234567890123456789' },
      { expectedRevision: '1', actor: 'owner' },
    );
    await pool.query(
      "INSERT INTO bots(name, strategy, risk_profile_id) VALUES ('test', 'momentum', 'balanced')",
    );
    expect(await migrateUp(pool)).toEqual([]);
    expect((await migrationStatus(pool)).every((m) => m.appliedAt !== null)).toBe(true);
    expect(await migrateDown(pool)).toEqual(['0010']);
    expect((await pool.query('SELECT * FROM risk_profiles')).rowCount).toBe(4);
    expect(await migrateUp(pool)).toEqual(['0010']);
    expect(await getRiskProfile(pool, 'balanced')).toMatchObject({
      minLiquidityUsd: '123456.1234567890123456789',
      safetyMode: 'standard',
    });
    expect((await pool.query('SELECT * FROM bots')).rowCount).toBe(1);
  });
});
