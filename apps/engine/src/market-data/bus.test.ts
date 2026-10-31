import { describe, expect, it } from 'vitest';
import type { MarketDiscoveryEvent } from '@memebots/core';

import { createDiscoveryBus } from './bus.js';
import { loadConfig } from '@memebots/config';
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
    expect(discoveryConfig().enabled).toBe(false);
    expect(
      loadConfig({ DATABASE_URL: 'postgresql://127.0.0.1/test', MARKET_DATA_ENABLED: 'true' })
        .discovery.enabled,
    ).toBe(true);
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://127.0.0.1/test', MARKET_DATA_ENABLED: '1' }),
    ).toThrow('MARKET_DATA_ENABLED');
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://127.0.0.1/test',
        SOLANA_RPC_URL: 'file:///credentials',
      }),
    ).toThrow('SOLANA_RPC_URL');
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://127.0.0.1/test',
        SOLANA_WS_URL: 'https://user:secret@example.test',
      }),
    ).toThrow('SOLANA_WS_URL');
  });
});
