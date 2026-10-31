import type { DiscoveryProtocol } from '@memebots/core';

export interface DiscoveryProgram {
  readonly id: string;
  readonly protocol: DiscoveryProtocol;
  readonly initializationHints: readonly string[];
}

/** Mainnet IDs and instruction names pinned in schemas.json primary-source manifest. */
export const PROGRAMS: readonly DiscoveryProgram[] = [
  {
    id: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    protocol: 'pump-fun',
    initializationHints: ['Create', 'CreateV2'],
  },
  {
    id: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    protocol: 'pump-swap',
    initializationHints: ['CreatePool'],
  },
  {
    id: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
    protocol: 'raydium-cpmm',
    initializationHints: ['Initialize', 'InitializeWithPermission'],
  },
  {
    id: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    protocol: 'raydium-clmm',
    initializationHints: ['CreatePool'],
  },
  {
    id: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    protocol: 'raydium-amm-v4',
    initializationHints: [],
  },
  {
    id: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    protocol: 'meteora-dlmm',
    initializationHints: [
      'InitializeCustomizablePermissionlessLbPair',
      'InitializeCustomizablePermissionlessLbPair2',
      'InitializeLbPair',
      'InitializeLbPair2',
      'InitializePermissionLbPair',
    ],
  },
  {
    id: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
    protocol: 'meteora-damm-v2',
    initializationHints: [
      'InitializePool',
      'InitializePoolWithDynamicConfig',
      'InitializeCustomizablePool',
    ],
  },
  {
    id: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
    protocol: 'meteora-damm-v1',
    initializationHints: [
      'InitializeCustomizablePermissionlessConstantProductPool',
      'InitializePermissionedPool',
      'InitializePermissionlessConstantProductPoolWithConfig',
      'InitializePermissionlessConstantProductPoolWithConfig2',
      'InitializePermissionlessPool',
      'InitializePermissionlessPoolWithFeeTier',
    ],
  },
];
