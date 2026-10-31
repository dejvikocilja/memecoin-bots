/** Entirely synthetic engineering scenarios. Never collected from or attributed to mainnet. */
import { CHECKS, unknownEvidence, validateEvidence } from './evidence.js';
import type { Check, Evidence } from './evidence.js';
import { base58 } from './rpc.js';
export const fixtureAddress = (byte: number): string => base58(Buffer.alloc(32, byte));
export const FIXTURE_MINT = fixtureAddress(1);
export function goodScenario(now = Date.now()): Evidence {
  const e = unknownEvidence(FIXTURE_MINT, null, now, 60000);
  e.decimals = 9;
  for (const check of CHECKS)
    Object.assign(e.checks[check], {
      provenance: {
        source: 'scenario_fixture',
        reference: 'synthetic_v1',
        slot: 100,
        commitment: 'confirmed',
      },
      coverage: 'complete_scenario',
      reason: 'OK',
    });
  e.checks.mintAuthority.facts = { authority: null };
  e.checks.freezeAuthority.facts = { authority: null };
  e.checks.lp.facts = {
    mappingVerified: true,
    mechanism: 'lock',
    withdrawalRestricted: true,
    lockedUntil: new Date(now + 3600000).toISOString(),
  };
  e.checks.holders.facts = {
    supplyRaw: '100000000000000000000',
    owners: Array.from({ length: 20 }, (_, i) => ({
      owner: fixtureAddress(i + 2),
      amountRaw: '5000000000000000000',
    })),
    complete: true,
    developerOwner: fixtureAddress(2),
    developerAttributionVerified: true,
  };
  e.checks.sell.facts = {
    routeVerified: true,
    accountsVerified: true,
    mint: FIXTURE_MINT,
    amountRaw: '9007199254740993',
    tokenDebitRaw: '9007199254740993',
    solCreditLamports: '100000',
    walletBalanceRaw: '100000000000000000',
    method: 'simulateTransaction',
    unsigned: true,
    simulationError: false,
  };
  e.checks.bundle.facts = {
    heuristicVersion: 'scenario_heuristic_v1',
    coverageComplete: true,
    coordinatedHoldingsDetected: false,
  };
  return validateEvidence(e);
}
export function rugScenario(check: Check, now = Date.now()): Evidence {
  const e = goodScenario(now);
  if (check === 'mintAuthority' || check === 'freezeAuthority')
    e.checks[check].facts!.authority = fixtureAddress(22);
  if (check === 'lp') e.checks.lp.facts!.mechanism = 'unlocked';
  if (check === 'holders') {
    const f = e.checks.holders.facts!;
    f.owners = [{ owner: fixtureAddress(2), amountRaw: f.supplyRaw }];
  }
  if (check === 'sell') e.checks.sell.facts!.simulationError = true;
  if (check === 'bundle') e.checks.bundle.facts!.coordinatedHoldingsDetected = true;
  return e;
}
export function unknownScenario(check: Check, now = Date.now()): Evidence {
  const e = goodScenario(now);
  e.checks[check] = unknownEvidence(FIXTURE_MINT, null, now, 60000).checks[check];
  return e;
}
