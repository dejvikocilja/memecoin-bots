import type { AppConfig } from '@memebots/config';
import { Secret } from '@memebots/config';

export type DiscoveryEndpoint = string | Secret;
export interface DiscoveryConfig {
  readonly enabled: boolean;
  readonly rpcUrl: DiscoveryEndpoint;
  readonly wsUrl: DiscoveryEndpoint;
  readonly queueLimit: number;
  readonly concurrency: number;
  readonly requestsPerSecond: number;
  readonly rpcTimeoutMs: number;
  readonly retryLimit: number;
  readonly ackTimeoutMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
  readonly dedupLimit: number;
  readonly dedupTtlMs: number;
}

/** Runtime settings are validated/wrapped by the shared startup boundary. */
export function discoveryConfig(
  settings: AppConfig['discovery'] = {
    enabled: false,
    rpcUrl: new Secret('https://api.mainnet-beta.solana.com'),
    wsUrl: new Secret('wss://api.mainnet-beta.solana.com'),
  },
): DiscoveryConfig {
  return {
    ...settings,
    queueLimit: 256,
    concurrency: 2,
    requestsPerSecond: 4,
    rpcTimeoutMs: 8_000,
    retryLimit: 3,
    ackTimeoutMs: 10_000,
    heartbeatTimeoutMs: 45_000,
    reconnectMinMs: 1_000,
    reconnectMaxMs: 30_000,
    dedupLimit: 20_000,
    dedupTtlMs: 10 * 60_000,
  };
}
