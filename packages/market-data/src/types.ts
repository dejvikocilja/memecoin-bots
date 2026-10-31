/** USD metrics for the selected pair, not aggregates across all of a token's pools. */
export interface WindowMetrics {
  volumeUsd: number | null;
  /** Counts transactions; multiple buys can belong to the same buyer. */
  buyTransactions: number | null;
  uniqueBuyers: null;
}

export interface TokenSnapshot {
  schemaVersion: 1;
  source: 'dexscreener';
  chain: 'solana';
  tokenAddress: string;
  pairAddress: string;
  dexId: string;
  /** Local receipt time only; this is not the age of the provider's quote. */
  observedAt: number;
  receivedAt: number;
  sourceTimestamp: null;
  priceUsd: string;
  liquidityUsd: number | null;
  windows: {
    m1: { volumeUsd: null; buyTransactions: null; uniqueBuyers: null };
    m5: WindowMetrics;
    h1: WindowMetrics;
  };
  quality: {
    sourceFreshness: 'unknown';
    timestampBasis: 'received_at';
    m1: 'not_provided';
    uniqueBuyers: 'not_provided';
    buyTransactions: 'transaction_count_not_unique_buyers';
    pairSelection: 'highest_known_liquidity_usd_then_pair_address';
  };
}

export type ProviderFailureReason =
  | 'missing'
  | 'invalid_data'
  | 'rate_limited'
  | 'http_error'
  | 'network_error'
  | 'timeout'
  | 'response_too_large';

export type TokenOutcome =
  | { status: 'ok'; tokenAddress: string; snapshot: TokenSnapshot }
  | {
      status: 'unavailable';
      tokenAddress: string;
      reason: ProviderFailureReason;
      retryAfterMs?: number;
    };

export interface ProviderBatchResult {
  receivedAt: number;
  outcomes: TokenOutcome[];
}

export interface SnapshotProvider {
  fetchSnapshots(tokenAddresses: readonly string[]): Promise<ProviderBatchResult>;
}
