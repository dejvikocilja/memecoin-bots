import { isReceiptFresh, isSolanaMint } from './provider.js';
import type { TokenSnapshot } from './types.js';

export interface SnapshotRequirements {
  now: number;
  maxReceiptAgeMs: number;
  /** Defaults to true: receipt of a response cannot establish quote freshness. */
  requireSourceTimestamp?: boolean;
  /** Each required window must contain USD volume and buy-transaction counts. */
  requiredWindows?: readonly ('m1' | 'm5' | 'h1')[];
  requireUniqueBuyers?: boolean;
  requireLiquidity?: boolean;
}

export interface SnapshotEvaluation {
  usable: boolean;
  reasons: string[];
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A data-availability gate only. Passing it does not authorize an order or replace
 * strategy-specific safety checks or the risk manager. Current DEX Screener
 * snapshots cannot pass the default requirement for a known source timestamp.
 */
export function evaluateSnapshot(
  snapshot: TokenSnapshot,
  requirements: SnapshotRequirements,
): SnapshotEvaluation {
  const {
    now,
    maxReceiptAgeMs,
    requireSourceTimestamp = true,
    requiredWindows = [],
    requireUniqueBuyers = false,
    requireLiquidity = false,
  } = requirements;
  if (
    !timestamp(now) ||
    !timestamp(maxReceiptAgeMs) ||
    typeof requireSourceTimestamp !== 'boolean' ||
    typeof requireUniqueBuyers !== 'boolean' ||
    typeof requireLiquidity !== 'boolean' ||
    !Array.isArray(requiredWindows) ||
    !requiredWindows.every((window) => ['m1', 'm5', 'h1'].includes(window))
  ) {
    throw new RangeError('Invalid market data requirements');
  }
  const reasons: string[] = [];
  if (
    !object(snapshot) ||
    snapshot.schemaVersion !== 1 ||
    snapshot.source !== 'dexscreener' ||
    snapshot.chain !== 'solana' ||
    !isSolanaMint(snapshot.tokenAddress) ||
    !isSolanaMint(snapshot.pairAddress) ||
    typeof snapshot.priceUsd !== 'string' ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(snapshot.priceUsd) ||
    !nonnegative(Number(snapshot.priceUsd)) ||
    Number(snapshot.priceUsd) === 0 ||
    !object(snapshot.windows) ||
    !object(snapshot.quality)
  ) {
    return { usable: false, reasons: ['invalid_snapshot'] };
  }
  if (!isReceiptFresh(snapshot, now, maxReceiptAgeMs)) reasons.push('receipt_stale_or_invalid');
  // This provider never exposes a source timestamp. Do not accept invented fields
  // from persisted JSON or confuse the pool's creation time with quote time.
  if (requireSourceTimestamp) reasons.push('source_timestamp_unavailable');
  if (requireLiquidity && !nonnegative(snapshot.liquidityUsd))
    reasons.push('liquidity_unavailable');
  for (const window of new Set<'m1' | 'm5' | 'h1'>(requiredWindows)) {
    const metrics = snapshot.windows[window];
    if (window === 'm1' || !object(metrics) || !nonnegative(metrics.volumeUsd)) {
      reasons.push(`${window}_volume_unavailable`);
    }
    if (
      window === 'm1' ||
      !object(metrics) ||
      !nonnegative(metrics.buyTransactions) ||
      !Number.isSafeInteger(metrics.buyTransactions)
    ) {
      reasons.push(`${window}_buy_transactions_unavailable`);
    }
  }
  // The provider supplies transaction counts, never distinct wallet counts.
  if (requireUniqueBuyers) reasons.push('unique_buyers_unavailable');
  return { usable: reasons.length === 0, reasons };
}
