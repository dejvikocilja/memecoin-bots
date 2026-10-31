export interface DiscoveryConfig {
  readonly enabled: boolean;
  readonly rpcUrl: string;
  readonly wsUrl: string;
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

export function discoveryConfig(env: NodeJS.ProcessEnv = process.env): DiscoveryConfig {
  const enabled = env.MARKET_DATA_ENABLED ?? 'false';
  if (enabled !== 'true' && enabled !== 'false')
    throw new Error('MARKET_DATA_ENABLED must be true or false');
  return {
    enabled: enabled === 'true',
    rpcUrl: endpoint(
      env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
      ['http:', 'https:'],
      'SOLANA_RPC_URL',
    ),
    wsUrl: endpoint(
      env.SOLANA_WS_URL ?? 'wss://api.mainnet-beta.solana.com',
      ['ws:', 'wss:'],
      'SOLANA_WS_URL',
    ),
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

function endpoint(value: string, protocols: readonly string[], name: string): string {
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || !url.hostname || url.hash) throw new Error();
    return url.href;
  } catch {
    // Never echo a credential-bearing endpoint in errors.
    throw new Error(`${name} must be a valid ${protocols.join('/')} URL`);
  }
}
