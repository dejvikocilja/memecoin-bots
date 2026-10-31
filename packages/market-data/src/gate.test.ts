import { describe, expect, it } from 'vitest';

import { evaluateSnapshot } from './gate.js';
import type { SnapshotRequirements } from './gate.js';
import type { TokenSnapshot } from './types.js';

const NOW = 1_793_470_000_000;
function snapshot(): TokenSnapshot {
  return {
    schemaVersion: 1,
    source: 'dexscreener',
    chain: 'solana',
    tokenAddress: 'So11111111111111111111111111111111111111112',
    pairAddress: '11111111111111111111111111111112',
    dexId: 'raydium',
    observedAt: NOW,
    receivedAt: NOW,
    sourceTimestamp: null,
    priceUsd: '0.0001',
    liquidityUsd: 0,
    windows: {
      m1: { volumeUsd: null, buyTransactions: null, uniqueBuyers: null },
      m5: { volumeUsd: 0, buyTransactions: 0, uniqueBuyers: null },
      h1: { volumeUsd: 500, buyTransactions: 8, uniqueBuyers: null },
    },
    quality: {
      sourceFreshness: 'unknown',
      timestampBasis: 'received_at',
      m1: 'not_provided',
      uniqueBuyers: 'not_provided',
      buyTransactions: 'transaction_count_not_unique_buyers',
      pairSelection: 'highest_known_liquidity_usd_then_pair_address',
    },
  };
}
const requirements = { now: NOW, maxReceiptAgeMs: 30_000 };

describe('snapshot availability gate', () => {
  it('fails closed by default when only local receipt time is known', () => {
    expect(evaluateSnapshot(snapshot(), requirements)).toEqual({
      usable: false,
      reasons: ['source_timestamp_unavailable'],
    });
  });

  it('allows explicit receipt-only analysis when all requested metrics are present', () => {
    expect(
      evaluateSnapshot(snapshot(), {
        ...requirements,
        requireSourceTimestamp: false,
        requiredWindows: ['m5', 'h1'],
        requireLiquidity: true,
      }),
    ).toEqual({ usable: true, reasons: [] });
  });

  it('does not treat missing one-minute metrics or distinct buyers as zero', () => {
    expect(
      evaluateSnapshot(snapshot(), {
        ...requirements,
        requireSourceTimestamp: false,
        requiredWindows: ['m1'],
        requireUniqueBuyers: true,
      }),
    ).toEqual({
      usable: false,
      reasons: [
        'm1_volume_unavailable',
        'm1_buy_transactions_unavailable',
        'unique_buyers_unavailable',
      ],
    });
  });

  it('fails when a requested supported metric or liquidity is missing', () => {
    const missing = snapshot();
    missing.windows.m5.volumeUsd = null;
    missing.windows.h1.buyTransactions = null;
    missing.liquidityUsd = null;
    expect(
      evaluateSnapshot(missing, {
        ...requirements,
        requireSourceTimestamp: false,
        requiredWindows: ['m5', 'h1'],
        requireLiquidity: true,
      }),
    ).toEqual({
      usable: false,
      reasons: [
        'liquidity_unavailable',
        'm5_volume_unavailable',
        'h1_buy_transactions_unavailable',
      ],
    });
  });

  it.each([NOW - 1, NOW + 30_001, Number.NaN])(
    'rejects stale or invalid receipt checks (%s)',
    (now) => {
      if (Number.isNaN(now)) {
        expect(() => evaluateSnapshot(snapshot(), { ...requirements, now })).toThrow(
          'Invalid market data requirements',
        );
      } else {
        expect(
          evaluateSnapshot(snapshot(), { ...requirements, now, requireSourceTimestamp: false }),
        ).toEqual({ usable: false, reasons: ['receipt_stale_or_invalid'] });
      }
    },
  );

  it('cannot bless invented one-minute metrics, wallet counts or source times in persisted JSON', () => {
    const injected = {
      ...snapshot(),
      sourceTimestamp: NOW,
      windows: {
        ...snapshot().windows,
        m1: { volumeUsd: 100, buyTransactions: 10, uniqueBuyers: 10 },
      },
    } as unknown as TokenSnapshot;
    const result = evaluateSnapshot(injected, {
      ...requirements,
      requiredWindows: ['m1'],
      requireUniqueBuyers: true,
    });
    expect(result.usable).toBe(false);
    expect(result.reasons).toContain('source_timestamp_unavailable');
    expect(result.reasons).toContain('m1_volume_unavailable');
    expect(result.reasons).toContain('unique_buyers_unavailable');
  });

  it('rejects corrupt snapshots and invalid mandatory numeric fields', () => {
    expect(evaluateSnapshot(null as unknown as TokenSnapshot, requirements)).toEqual({
      usable: false,
      reasons: ['invalid_snapshot'],
    });
    expect(evaluateSnapshot({ ...snapshot(), priceUsd: 'NaN' }, requirements).usable).toBe(false);
    const invalid = snapshot();
    invalid.liquidityUsd = Number.POSITIVE_INFINITY;
    invalid.windows.h1.buyTransactions = 0.5;
    expect(
      evaluateSnapshot(invalid, {
        ...requirements,
        requireSourceTimestamp: false,
        requiredWindows: ['h1'],
        requireLiquidity: true,
      }).reasons,
    ).toEqual(['liquidity_unavailable', 'h1_buy_transactions_unavailable']);
  });

  it.each([
    { now: Number.POSITIVE_INFINITY },
    { now: -1 },
    { maxReceiptAgeMs: -1 },
    { maxReceiptAgeMs: Number.NaN },
    { requireSourceTimestamp: 'false' },
    { requireUniqueBuyers: 1 },
    { requiredWindows: ['h24'] },
    { requiredWindows: null },
  ])('rejects invalid requirements: %j', (invalid) => {
    expect(() =>
      evaluateSnapshot(snapshot(), { ...requirements, ...invalid } as SnapshotRequirements),
    ).toThrow('Invalid market data requirements');
  });
});
