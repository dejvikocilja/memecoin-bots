/**
 * What a strategy hands to the risk manager (spec section 4). A strategy never
 * sizes or exits a position itself.
 */
export type Side = 'buy' | 'sell';

export interface Signal {
  /** Token mint address. */
  readonly token: string;
  readonly side: Side;
  /** 0 to 1. */
  readonly confidence: number;
  /** Human-readable reason, shown on the dashboard and in the audit log. */
  readonly reason: string;
  /** Suggested stop distance as a fraction of entry price (0.2 = 20% below). */
  readonly suggestedStopDistance?: number;
}

export function validateSignal(signal: Signal): string[] {
  const problems: string[] = [];
  if (signal.token.trim() === '') problems.push('token is empty');
  if (!(signal.confidence >= 0 && signal.confidence <= 1)) {
    problems.push('confidence must be between 0 and 1');
  }
  if (signal.reason.trim() === '') problems.push('reason is empty');
  const stop = signal.suggestedStopDistance;
  if (stop !== undefined && !(stop > 0 && stop < 1)) {
    problems.push('suggestedStopDistance must be between 0 and 1');
  }
  return problems;
}
