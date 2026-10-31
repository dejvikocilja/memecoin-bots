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
