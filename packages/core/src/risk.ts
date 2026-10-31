/**
 * The four risk profiles from spec section 5. Their numbers live in the
 * database (BOT-10); this is only the closed list of names.
 */
export const RISK_PROFILE_NAMES = ['conservative', 'balanced', 'aggressive', 'degen'] as const;
export type RiskProfileName = (typeof RISK_PROFILE_NAMES)[number];

/** Hard ceiling on position size for any profile: 5% of the bot's bankroll. */
export const MAX_POSITION_FRACTION = 0.05;

export function isRiskProfileName(value: unknown): value is RiskProfileName {
  return typeof value === 'string' && (RISK_PROFILE_NAMES as readonly string[]).includes(value);
}

/** One step of a take-profit ladder: once price is up `atGain` (0.3 = +30%), sell `sellFraction` of the original size. */
export interface TakeProfitStep {
  readonly atGain: number;
  readonly sellFraction: number;
}

export const SAFETY_MODES = ['strict', 'standard', 'relaxed'] as const;
export type SafetyMode = (typeof SAFETY_MODES)[number];

/** Exact decimal strings cross the database/JSON boundary without rounding. */
export interface RiskProfileConfig {
  readonly displayName: string;
  readonly positionFraction: string;
  readonly stopLossFraction: string;
  readonly takeProfitLadder: readonly TakeProfitStep[];
  readonly trailingStopFraction: string | null;
  readonly minRewardRisk: string;
  readonly maxOpenPositions: number;
  readonly dailyLossLimitFraction: string;
  readonly maxSlippageBps: number;
  readonly minLiquidityUsd: string;
  readonly minSafetyScore: number;
  readonly maxHoldMinutes: number;
  readonly losingStreakLimit: number;
  readonly safetyMode: SafetyMode;
}

export interface RiskProfile extends RiskProfileConfig {
  readonly id: string;
  /** Opaque optimistic concurrency token; supply unchanged when editing. */
  readonly revision: string;
}

export const RISK_PROFILE_FIELDS = [
  'displayName',
  'positionFraction',
  'stopLossFraction',
  'takeProfitLadder',
  'trailingStopFraction',
  'minRewardRisk',
  'maxOpenPositions',
  'dailyLossLimitFraction',
  'maxSlippageBps',
  'minLiquidityUsd',
  'minSafetyScore',
  'maxHoldMinutes',
  'losingStreakLimit',
  'safetyMode',
] as const satisfies readonly (keyof RiskProfileConfig)[];

export function isProfileObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Compare decimal strings exactly; never round a value slightly above the 5% ceiling.
function compareDecimal(a: string, b: string): number {
  const [ai = '', af = ''] = a.split('.');
  const [bi = '', bf = ''] = b.split('.');
  const scale = Math.max(af.length, bf.length);
  const av = BigInt(ai + af.padEnd(scale, '0'));
  const bv = BigInt(bi + bf.padEnd(scale, '0'));
  return av < bv ? -1 : av > bv ? 1 : 0;
}

// JSON ladder numbers retain the established API. Sum their decimal spellings exactly.
function saleUnits(value: number): bigint {
  const [mantissa = '', exponent = '0'] = value.toString().split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  return BigInt(whole + fraction) * 10n ** BigInt(324 + Number(exponent) - fraction.length);
}

/** Validate a full configuration, including all fields after a partial edit is merged. */
export function validateRiskProfile(value: unknown): string[] {
  if (!isProfileObject(value)) return ['profile must be an object'];
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!(RISK_PROFILE_FIELDS as readonly string[]).includes(key))
      errors.push(`unknown field: ${key}`);
  }
  if (
    typeof value.displayName !== 'string' ||
    value.displayName.trim() === '' ||
    value.displayName.length > 100
  ) {
    errors.push('displayName must contain 1 to 100 characters');
  }
  const decimal = (
    key: string,
    lower: string,
    upper?: string,
    inclusiveUpper = false,
    allowZero = false,
  ) => {
    const v = value[key];
    if (typeof v !== 'string' || v.length > 80 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(v)) {
      errors.push(`${key} must be a plain nonnegative decimal string (at most 80 characters)`);
    } else if (
      compareDecimal(v, lower) < (allowZero ? 0 : 1) ||
      (upper !== undefined && compareDecimal(v, upper) >= (inclusiveUpper ? 1 : 0))
    ) {
      errors.push(`${key} is outside its permitted bounds`);
    }
  };
  decimal('positionFraction', '0', '0.05', true);
  decimal('stopLossFraction', '0', '1');
  decimal('dailyLossLimitFraction', '0', '1');
  decimal('minRewardRisk', '0');
  decimal('minLiquidityUsd', '0', undefined, false, true);
  if (value.trailingStopFraction !== null) decimal('trailingStopFraction', '0', '1');
  for (const [key, max] of [
    ['maxOpenPositions', 2147483647],
    ['maxSlippageBps', 5000],
    ['minSafetyScore', 100],
    ['maxHoldMinutes', 2147483647],
    ['losingStreakLimit', 2147483647],
  ] as const) {
    const v = value[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max)
      errors.push(`${key} must be an integer from 1 to ${max}`);
  }
  if (!(SAFETY_MODES as readonly unknown[]).includes(value.safetyMode))
    errors.push('safetyMode must be strict, standard or relaxed');
  const ladder = value.takeProfitLadder;
  if (!Array.isArray(ladder) || ladder.length === 0 || ladder.length > 100) {
    errors.push('takeProfitLadder must contain 1 to 100 steps');
  } else {
    let previous = 0;
    let total = 0n;
    for (const step of ladder) {
      if (
        !isProfileObject(step) ||
        Object.keys(step).length !== 2 ||
        typeof step.atGain !== 'number' ||
        !Number.isFinite(step.atGain) ||
        step.atGain <= previous ||
        typeof step.sellFraction !== 'number' ||
        !Number.isFinite(step.sellFraction) ||
        step.sellFraction <= 0 ||
        step.sellFraction > 1
      ) {
        errors.push(
          'ladder steps require strictly ascending positive finite atGain and sellFraction in (0,1]',
        );
        continue;
      }
      previous = step.atGain;
      total += saleUnits(step.sellFraction);
    }
    const all = 10n ** 324n;
    if (total > all) errors.push('ladder cannot sell more than the original position');
    if (total < all && value.trailingStopFraction === null)
      errors.push('unsold remainder requires a trailing stop');
  }
  return errors;
}
