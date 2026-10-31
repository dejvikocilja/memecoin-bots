/** Observations at confirmed commitment. These are discovery signals, not trade approvals. */
export type DiscoveryProtocol =
  | 'pump-fun'
  | 'pump-swap'
  | 'raydium-cpmm'
  | 'raydium-clmm'
  | 'raydium-amm-v4'
  | 'meteora-dlmm'
  | 'meteora-damm-v2'
  | 'meteora-damm-v1';

interface Observation {
  readonly chain: 'solana';
  readonly commitment: 'confirmed';
  /** Pinned upstream event or instruction name used to decode the observation. */
  readonly source: string;
  readonly blockTime?: number;
  /** Stable across delivery/reconnection: signature + instruction/event position. */
  readonly id: string;
  readonly protocol: DiscoveryProtocol;
  readonly programId: string;
  readonly signature: string;
  readonly slot: number;
  readonly observedAt: number;
}

export type MarketDiscoveryEvent = Observation &
  (
    | {
        readonly kind: 'token-launched';
        readonly protocol: 'pump-fun';
        readonly mint: string;
        readonly bondingCurve: string;
        readonly quoteMint: string;
        readonly creator: string;
      }
    | {
        readonly kind: 'bonding-curve-completed';
        readonly protocol: 'pump-fun';
        readonly mint: string;
        readonly bondingCurve: string;
        readonly quoteMint: string;
      }
    | {
        readonly kind: 'pool-created';
        readonly pool: string;
        readonly mintA: string;
        readonly mintB: string;
      }
  );
