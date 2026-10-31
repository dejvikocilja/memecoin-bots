import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOT_MODE,
  MAX_POSITION_FRACTION,
  RISK_PROFILE_NAMES,
  isRiskProfileName,
  parseBotMode,
  validateSignal,
} from './index.js';

describe('parseBotMode', () => {
  it('defaults to paper when nothing is set', () => {
    expect(parseBotMode(undefined)).toBe('paper');
    expect(parseBotMode('  ')).toBe('paper');
    expect(DEFAULT_BOT_MODE).toBe('paper');
  });

  it('accepts known modes in any case', () => {
    expect(parseBotMode('LIVE')).toBe('live');
    expect(parseBotMode(' off ')).toBe('off');
  });

  it('rejects unknown modes instead of guessing', () => {
    expect(() => parseBotMode('yolo')).toThrow(/Unknown bot mode/);
  });
});

describe('risk profiles', () => {
  it('has exactly the four profiles from the spec', () => {
    expect(RISK_PROFILE_NAMES).toEqual(['conservative', 'balanced', 'aggressive', 'degen']);
    expect(isRiskProfileName('degen')).toBe(true);
    expect(isRiskProfileName('reckless')).toBe(false);
  });

  it('caps position size at 5%', () => {
    expect(MAX_POSITION_FRACTION).toBe(0.05);
  });
});

describe('validateSignal', () => {
  const ok = {
    token: 'So11111111111111111111111111111111111111112',
    side: 'buy',
    confidence: 0.7,
    reason: 'breakout',
  } as const;

  it('accepts a well-formed signal', () => {
    expect(validateSignal(ok)).toEqual([]);
  });

  it('lists every problem', () => {
    expect(
      validateSignal({ ...ok, token: '', confidence: 2, reason: '', suggestedStopDistance: 1.5 }),
    ).toHaveLength(4);
  });
});
