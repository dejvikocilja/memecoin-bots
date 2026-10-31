import { describe, expect, it } from 'vitest';

import { validateRiskProfile } from './risk.js';
import type { RiskProfileConfig } from './risk.js';

const valid: RiskProfileConfig = {
  displayName: 'Balanced',
  positionFraction: '0.02',
  stopLossFraction: '0.20',
  takeProfitLadder: [
    { atGain: 0.3, sellFraction: 0.4 },
    { atGain: 0.6, sellFraction: 0.3 },
  ],
  trailingStopFraction: '0.15',
  minRewardRisk: '2',
  maxOpenPositions: 5,
  dailyLossLimitFraction: '0.06',
  maxSlippageBps: 200,
  minLiquidityUsd: '50000',
  minSafetyScore: 75,
  maxHoldMinutes: 360,
  losingStreakLimit: 4,
  safetyMode: 'standard',
};

describe('risk policy validation', () => {
  it('accepts complete policy and exact valid boundaries', () => {
    expect(validateRiskProfile(valid)).toEqual([]);
    expect(
      validateRiskProfile({
        ...valid,
        positionFraction: '0.05',
        minLiquidityUsd: '0',
        maxSlippageBps: 5000,
        minSafetyScore: 1,
        trailingStopFraction: null,
        takeProfitLadder: [
          { atGain: 1, sellFraction: 0.1 },
          { atGain: 2, sellFraction: 0.2 },
          { atGain: 3, sellFraction: 0.7 },
        ],
      }),
    ).toEqual([]);
  });

  const invalid: [string, unknown][] = [
    ['positionFraction', '0'],
    ['positionFraction', '0.0500000000000000000001'],
    ['positionFraction', 0.02],
    ['stopLossFraction', '1'],
    ['stopLossFraction', '-0.1'],
    ['stopLossFraction', 'NaN'],
    ['trailingStopFraction', 'Infinity'],
    ['trailingStopFraction', '0'],
    ['minRewardRisk', '0'],
    ['minRewardRisk', '1e3'],
    ['minRewardRisk', ' 2'],
    ['dailyLossLimitFraction', '1'],
    ['dailyLossLimitFraction', '0'],
    ['maxSlippageBps', 5001],
    ['maxSlippageBps', 0],
    ['maxSlippageBps', 1.5],
    ['minLiquidityUsd', '-1'],
    ['minLiquidityUsd', 'NaN'],
    ['minSafetyScore', 0],
    ['minSafetyScore', 101],
    ['maxHoldMinutes', 0],
    ['maxHoldMinutes', 1.1],
    ['maxOpenPositions', NaN],
    ['maxOpenPositions', 0],
    ['losingStreakLimit', Infinity],
    ['losingStreakLimit', 0],
    ['safetyMode', 'off'],
    ['displayName', ''],
    ['displayName', 'x'.repeat(101)],
    ['unexpected', true],
    ['takeProfitLadder', []],
    ['takeProfitLadder', {}],
    ['takeProfitLadder', [null]],
    ['takeProfitLadder', [{ atGain: 0, sellFraction: 0.5 }]],
    ['takeProfitLadder', [{ atGain: Infinity, sellFraction: 0.5 }]],
    ['takeProfitLadder', [{ atGain: 1, sellFraction: NaN }]],
    ['takeProfitLadder', [{ atGain: 1, sellFraction: -0.1 }]],
    [
      'takeProfitLadder',
      [
        { atGain: 1, sellFraction: 0.7 },
        { atGain: 1, sellFraction: 0.1 },
      ],
    ],
    [
      'takeProfitLadder',
      [
        { atGain: 2, sellFraction: 0.7 },
        { atGain: 1, sellFraction: 0.1 },
      ],
    ],
    [
      'takeProfitLadder',
      [
        { atGain: 1, sellFraction: 0.7 },
        { atGain: 2, sellFraction: 0.30000000000000004 },
      ],
    ],
    ['takeProfitLadder', [{ atGain: 1, sellFraction: 0.5, extra: true }]],
    ['trailingStopFraction', null],
  ];
  it.each(invalid)('rejects impossible %s = %j', (key, value) => {
    expect(validateRiskProfile({ ...valid, [key]: value }).length).toBeGreaterThan(0);
  });

  it('rejects malformed whole inputs and missing fields without throwing', () => {
    for (const value of [null, [], undefined, 3, {}, { ...valid, maxHoldMinutes: undefined }]) {
      expect(validateRiskProfile(value).length).toBeGreaterThan(0);
    }
  });
});
