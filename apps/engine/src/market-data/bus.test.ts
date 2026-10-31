import { describe, expect, it } from 'vitest';
import type { MarketDiscoveryEvent } from '@memebots/core';

import { createDiscoveryBus } from './bus.js';
import { discoveryConfig } from './config.js';

const observation: MarketDiscoveryEvent = {
  id: 'fixture',
  chain: 'solana',
  commitment: 'confirmed',
  source: 'fixture',
  signature: 'fixture',
  programId: 'fixture',
  protocol: 'raydium-cpmm',
  slot: 1,
  observedAt: 1,
  kind: 'pool-created',
  pool: 'fixture',
  mintA: 'a',
  mintB: 'b',
};

describe('discovery bus and configuration', () => {
  it('isolates consumers and failing error reporters with stable delivery membership', () => {
    const calls: string[] = [];
    const bus = createDiscoveryBus(() => {
      throw new Error('reporter failed');
    });
    const late = () => {
      calls.push('late');
    };
    bus.subscribe(() => {
      bus.subscribe(late);
      throw new Error('consumer failed');
    });
    const unsubscribe = bus.subscribe(() => calls.push('healthy'));
    bus.publish(observation);
    expect(calls).toEqual(['healthy']);
    unsubscribe();
    bus.publish(observation);
    expect(calls).toEqual(['healthy', 'late']);
  });

  it('defaults off and validates explicit opt-in and endpoint schemes without echoing credentials', () => {
    expect(discoveryConfig({}).enabled).toBe(false);
    expect(discoveryConfig({ MARKET_DATA_ENABLED: 'true' }).enabled).toBe(true);
    expect(() => discoveryConfig({ MARKET_DATA_ENABLED: '1' })).toThrow('true or false');
    expect(() => discoveryConfig({ SOLANA_RPC_URL: 'file:///credentials' })).toThrow(
      'SOLANA_RPC_URL',
    );
    expect(() => discoveryConfig({ SOLANA_WS_URL: 'https://user:secret@example.test' })).toThrow(
      /^SOLANA_WS_URL must be a valid ws:\/wss: URL$/,
    );
  });
});
