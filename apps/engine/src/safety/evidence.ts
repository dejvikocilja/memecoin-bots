import { createHash } from 'node:crypto';

export const CHECKS = [
  'mintAuthority',
  'freezeAuthority',
  'lp',
  'holders',
  'sell',
  'bundle',
] as const;
export type Check = (typeof CHECKS)[number];
export const WEIGHTS: Record<Check, number> = {
  mintAuthority: 20,
  freezeAuthority: 15,
  lp: 20,
  holders: 20,
  sell: 15,
  bundle: 10,
};
export const REASONS = [
  'OK',
  'ACTIVE_AUTHORITY',
  'UNSUPPORTED',
  'RPC_UNAVAILABLE',
  'INVALID_MINT',
  'INCOMPLETE',
  'CONCENTRATION',
  'UNLOCKED',
  'SIMULATION_FAILED',
  'COORDINATED',
  'EXPIRED',
  'INVALID_EVIDENCE',
] as const;
export type Reason = (typeof REASONS)[number];
export type Status = 'pass' | 'fail' | 'unknown';
export interface Provenance {
  source: 'solana_rpc' | 'scenario_fixture' | 'unsupported';
  reference: 'classic_spl_rpc_v1' | 'synthetic_v1' | 'no_adapter';
  slot: number | null;
  commitment: 'confirmed';
}
export interface Observation {
  observedAt: string;
  expiresAt: string;
  provenance: Provenance;
  coverage: 'mint' | 'top20_accounts' | 'complete_scenario' | 'unsupported';
  reason: Reason;
  facts: Record<string, unknown> | null;
}
export interface Evidence {
  schemaVersion: 1;
  chain: 'solana';
  mint: string;
  pool: string | null;
  decimals: number | null;
  checks: Record<Check, Observation>;
}
export interface Policy {
  version: 'engineering_v1';
  minScore: number;
  maxOwnerBps: number;
  maxDeveloperBps: number;
  maxAgeMs: number;
  refreshMs: number;
  negativeCacheMs: number;
}
/** Engineering scenario defaults, not measured risk or a safety guarantee. All six checks required. */
export const DEFAULT_POLICY: Policy = {
  version: 'engineering_v1',
  minScore: 100,
  maxOwnerBps: 1000,
  maxDeveloperBps: 500,
  maxAgeMs: 60_000,
  refreshMs: 60_000,
  negativeCacheMs: 10_000,
};
export interface Decision {
  policyVersion: string;
  policyFingerprint: string;
  passed: boolean;
  score: number;
  scenario: boolean;
  checks: Record<Check, { status: Status; reason: Reason }>;
}
export function object(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
export function address(v: unknown): v is string {
  return typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}
export function raw(v: unknown): v is string {
  return typeof v === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(v);
}
function exactKeys(v: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(v).length === keys.length && keys.every((k) => k in v);
}
function date(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
export function validatePolicy(value: unknown): Policy {
  if (
    !object(value) ||
    !exactKeys(value, Object.keys(DEFAULT_POLICY)) ||
    value.version !== 'engineering_v1'
  )
    throw new Error('INVALID_POLICY');
  for (const key of [
    'minScore',
    'maxOwnerBps',
    'maxDeveloperBps',
    'maxAgeMs',
    'refreshMs',
    'negativeCacheMs',
  ] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1)
      throw new Error('INVALID_POLICY');
  }
  if (
    (value.minScore as number) > 100 ||
    (value.maxOwnerBps as number) > 10000 ||
    (value.maxDeveloperBps as number) > 10000 ||
    (value.maxAgeMs as number) > 300000 ||
    (value.refreshMs as number) > 300000 ||
    (value.negativeCacheMs as number) > 60000
  )
    throw new Error('INVALID_POLICY');
  return value as unknown as Policy;
}
export function policyFingerprint(policy: Policy): string {
  validatePolicy(policy);
  return createHash('sha256')
    .update(JSON.stringify(Object.keys(DEFAULT_POLICY).map((k) => [k, policy[k as keyof Policy]])))
    .digest('hex');
}
/** Only normalized public facts are accepted. Arbitrary RPC bodies and URLs cannot enter this schema. */
export function validateEvidence(value: unknown): Evidence {
  if (
    !object(value) ||
    !exactKeys(value, ['schemaVersion', 'chain', 'mint', 'pool', 'decimals', 'checks']) ||
    value.schemaVersion !== 1 ||
    value.chain !== 'solana' ||
    !address(value.mint) ||
    (value.pool !== null && !address(value.pool)) ||
    (value.decimals !== null &&
      (!Number.isInteger(value.decimals) ||
        (value.decimals as number) < 0 ||
        (value.decimals as number) > 18)) ||
    !object(value.checks) ||
    !exactKeys(value.checks, [...CHECKS])
  )
    throw new Error('INVALID_EVIDENCE');
  for (const check of CHECKS) {
    const o = value.checks[check];
    if (
      !object(o) ||
      !exactKeys(o, ['observedAt', 'expiresAt', 'provenance', 'coverage', 'reason', 'facts']) ||
      !date(o.observedAt) ||
      !date(o.expiresAt) ||
      Date.parse(o.expiresAt) <= Date.parse(o.observedAt) ||
      Date.parse(o.expiresAt) - Date.parse(o.observedAt) > 300000 ||
      !REASONS.includes(o.reason as Reason) ||
      !['mint', 'top20_accounts', 'complete_scenario', 'unsupported'].includes(
        o.coverage as string,
      ) ||
      !object(o.provenance)
    )
      throw new Error('INVALID_EVIDENCE');
    const p = o.provenance;
    if (
      !exactKeys(p, ['source', 'reference', 'slot', 'commitment']) ||
      p.commitment !== 'confirmed' ||
      (p.slot !== null && (!Number.isSafeInteger(p.slot) || (p.slot as number) < 0)) ||
      !['solana_rpc', 'scenario_fixture', 'unsupported'].includes(p.source as string) ||
      !['classic_spl_rpc_v1', 'synthetic_v1', 'no_adapter'].includes(p.reference as string)
    )
      throw new Error('INVALID_EVIDENCE');
    if (
      (p.source === 'solana_rpc' &&
        (p.reference !== 'classic_spl_rpc_v1' ||
          p.slot === null ||
          !['mint', 'top20_accounts'].includes(o.coverage as string))) ||
      (p.source === 'scenario_fixture' &&
        (p.reference !== 'synthetic_v1' || o.coverage !== 'complete_scenario')) ||
      (p.source === 'unsupported' &&
        (p.reference !== 'no_adapter' || o.facts !== null || o.coverage !== 'unsupported'))
    )
      throw new Error('INVALID_EVIDENCE');
    if (o.facts === null) {
      if (o.reason === 'OK') throw new Error('INVALID_EVIDENCE');
      continue;
    }
    if (!object(o.facts)) throw new Error('INVALID_EVIDENCE');
    const f = o.facts;
    let valid = false;
    if (check === 'mintAuthority' || check === 'freezeAuthority')
      valid = exactKeys(f, ['authority']) && (f.authority === null || address(f.authority));
    if (check === 'lp')
      valid =
        exactKeys(f, ['mappingVerified', 'mechanism', 'withdrawalRestricted', 'lockedUntil']) &&
        typeof f.mappingVerified === 'boolean' &&
        ['burn', 'lock', 'unlocked'].includes(f.mechanism as string) &&
        typeof f.withdrawalRestricted === 'boolean' &&
        (f.lockedUntil === null || date(f.lockedUntil));
    if (check === 'holders')
      valid =
        exactKeys(f, [
          'supplyRaw',
          'owners',
          'complete',
          'developerOwner',
          'developerAttributionVerified',
        ]) &&
        raw(f.supplyRaw) &&
        typeof f.complete === 'boolean' &&
        typeof f.developerAttributionVerified === 'boolean' &&
        (f.developerOwner === null || address(f.developerOwner)) &&
        Array.isArray(f.owners) &&
        f.owners.length <= 20 &&
        f.owners.every(
          (v) =>
            object(v) &&
            exactKeys(v, ['owner', 'amountRaw']) &&
            address(v.owner) &&
            raw(v.amountRaw),
        );
    if (check === 'sell')
      valid =
        exactKeys(f, [
          'routeVerified',
          'accountsVerified',
          'mint',
          'amountRaw',
          'tokenDebitRaw',
          'solCreditLamports',
          'walletBalanceRaw',
          'method',
          'unsigned',
          'simulationError',
        ]) &&
        typeof f.routeVerified === 'boolean' &&
        typeof f.accountsVerified === 'boolean' &&
        address(f.mint) &&
        raw(f.amountRaw) &&
        raw(f.tokenDebitRaw) &&
        raw(f.solCreditLamports) &&
        raw(f.walletBalanceRaw) &&
        f.method === 'simulateTransaction' &&
        f.unsigned === true &&
        typeof f.simulationError === 'boolean';
    if (check === 'bundle')
      valid =
        exactKeys(f, ['heuristicVersion', 'coverageComplete', 'coordinatedHoldingsDetected']) &&
        f.heuristicVersion === 'scenario_heuristic_v1' &&
        typeof f.coverageComplete === 'boolean' &&
        typeof f.coordinatedHoldingsDetected === 'boolean';
    // No protocol or simulation adapter is implemented in live RPC v1.
    if (
      p.source === 'solana_rpc' &&
      ((check === 'holders' &&
        (o.coverage !== 'top20_accounts' ||
          f.complete !== false ||
          f.developerAttributionVerified !== false ||
          f.developerOwner !== null)) ||
        (check !== 'holders' && o.coverage !== 'mint'))
    )
      throw new Error('INVALID_EVIDENCE');
    if (
      !valid ||
      (p.source === 'solana_rpc' &&
        !['mintAuthority', 'freezeAuthority', 'holders'].includes(check))
    )
      throw new Error('INVALID_EVIDENCE');
  }
  return value as unknown as Evidence;
}
function assess(
  check: Check,
  o: Observation,
  policy: Policy,
  mint: string,
  now: number,
): { status: Status; reason: Reason } {
  const result = (status: Status, reason: Reason) => ({ status, reason });
  if (
    Date.parse(o.observedAt) > now ||
    Date.parse(o.expiresAt) <= now ||
    now - Date.parse(o.observedAt) > policy.maxAgeMs
  )
    return result('unknown', 'EXPIRED');
  const f = o.facts;
  if (f && o.provenance.slot === null) return result('unknown', 'INCOMPLETE');
  if (!f) return result('unknown', o.reason);
  if (check === 'mintAuthority' || check === 'freezeAuthority')
    return f.authority === null ? result('pass', 'OK') : result('fail', 'ACTIVE_AUTHORITY');
  if (check === 'lp') {
    if (!f.mappingVerified) return result('unknown', 'INCOMPLETE');
    if (f.mechanism === 'burn')
      return f.withdrawalRestricted ? result('pass', 'OK') : result('unknown', 'INCOMPLETE');
    return f.mechanism === 'lock' &&
      f.withdrawalRestricted &&
      typeof f.lockedUntil === 'string' &&
      Date.parse(f.lockedUntil) > now
      ? result('pass', 'OK')
      : result('fail', 'UNLOCKED');
  }
  if (check === 'holders') {
    const supply = BigInt(f.supplyRaw as string);
    const owners = f.owners as { owner: string; amountRaw: string }[];
    const aggregate = new Map<string, bigint>();
    for (const owner of owners)
      aggregate.set(owner.owner, (aggregate.get(owner.owner) ?? 0n) + BigInt(owner.amountRaw));
    if (supply === 0n || [...aggregate.values()].reduce((a, b) => a + b, 0n) > supply)
      return result('unknown', 'INVALID_EVIDENCE');
    if (
      [...aggregate.values()].some(
        (amount) => amount * 10000n > supply * BigInt(policy.maxOwnerBps),
      )
    )
      return result('fail', 'CONCENTRATION');
    if (
      f.developerAttributionVerified &&
      typeof f.developerOwner === 'string' &&
      (aggregate.get(f.developerOwner) ?? 0n) * 10000n > supply * BigInt(policy.maxDeveloperBps)
    )
      return result('fail', 'CONCENTRATION');
    if (f.complete && [...aggregate.values()].reduce((a, b) => a + b, 0n) !== supply)
      return result('unknown', 'INCOMPLETE');
    if (!f.complete || !f.developerAttributionVerified || typeof f.developerOwner !== 'string')
      return result('unknown', 'INCOMPLETE');
    return result('pass', 'OK');
  }
  if (check === 'sell') {
    if (
      !f.routeVerified ||
      !f.accountsVerified ||
      f.mint !== mint ||
      BigInt(f.amountRaw as string) === 0n ||
      BigInt(f.walletBalanceRaw as string) < BigInt(f.amountRaw as string)
    )
      return result('unknown', 'INCOMPLETE');
    if (
      f.simulationError ||
      f.tokenDebitRaw !== f.amountRaw ||
      BigInt(f.solCreditLamports as string) === 0n
    )
      return result('fail', 'SIMULATION_FAILED');
    return result('pass', 'OK');
  }
  if (f.coordinatedHoldingsDetected) return result('fail', 'COORDINATED');
  return f.coverageComplete ? result('pass', 'OK') : result('unknown', 'INCOMPLETE');
}
export function evaluate(evidence: Evidence, policy: Policy, now = Date.now()): Decision {
  validateEvidence(evidence);
  validatePolicy(policy);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('INVALID_CLOCK');
  const checks = Object.fromEntries(
    CHECKS.map((check) => [
      check,
      assess(check, evidence.checks[check], policy, evidence.mint, now),
    ]),
  ) as Decision['checks'];
  const score = CHECKS.reduce(
    (score, check) => score + (checks[check].status === 'pass' ? WEIGHTS[check] : 0),
    0,
  );
  return {
    policyVersion: policy.version,
    policyFingerprint: policyFingerprint(policy),
    passed: CHECKS.every((c) => checks[c].status === 'pass') && score >= policy.minScore,
    score,
    scenario: CHECKS.some((c) => evidence.checks[c].provenance.source === 'scenario_fixture'),
    checks,
  };
}
export function unknownEvidence(
  mint: string,
  pool: string | null,
  now: number,
  ttl: number,
  reason: Reason = 'UNSUPPORTED',
): Evidence {
  if (!address(mint) || (pool !== null && !address(pool))) throw new Error('INVALID_ADDRESS');
  return {
    schemaVersion: 1,
    chain: 'solana',
    mint,
    pool,
    decimals: null,
    checks: Object.fromEntries(
      CHECKS.map((check) => [
        check,
        {
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + ttl).toISOString(),
          provenance: {
            source: 'unsupported',
            reference: 'no_adapter',
            slot: null,
            commitment: 'confirmed',
          },
          coverage: 'unsupported',
          reason,
          facts: null,
        },
      ]),
    ) as Evidence['checks'],
  };
}
