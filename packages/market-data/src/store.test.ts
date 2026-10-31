import { describe, expect, it } from 'vitest';

import { StoreError, validateCycle } from './store.js';
import type { StoredCycle } from './store.js';

const valid: StoredCycle = {
  id: 'dexscreener-solana:30000',
  scheduledAt: 30000,
  completedAt: 30001,
  outcomes: [{ status: 'unavailable', tokenAddress: 'mint', reason: 'missing' }],
};

describe('durable cycle validation', () => {
  it('accepts explicit data gaps and a restart interval', () => {
    expect(() => validateCycle({ ...valid, gapFrom: 0 })).not.toThrow();
  });

  it.each([
    { id: '' },
    { scheduledAt: Number.MAX_SAFE_INTEGER + 1 },
    { scheduledAt: -1 },
    { scheduledAt: 1.5 },
    { completedAt: 29999 },
    { gapFrom: 30001 },
    { gapFrom: Number.NaN },
    { outcomes: [] },
    { outcomes: [valid.outcomes[0]!, valid.outcomes[0]!] },
    { outcomes: [{ status: 'unavailable', tokenAddress: '', reason: 'missing' }] },
  ])('rejects invalid or ambiguous checkpoints: %j', (change) => {
    expect(() => validateCycle({ ...valid, ...change } as StoredCycle)).toThrow(StoreError);
  });

  it('uses fixed error messages without driver or credential details', () => {
    expect(new StoreError('connection_failed').message).toBe(
      'Market data storage: connection_failed',
    );
  });
});
