import type { SafetyStore } from '@memebots/db';
import type { SafetyCache } from '@memebots/db';
import {
  address,
  CHECKS,
  DEFAULT_POLICY,
  evaluate,
  unknownEvidence,
  validateEvidence,
  validatePolicy,
} from './evidence.js';
import type { Decision, Evidence, Policy } from './evidence.js';

export interface SafetyReport {
  mint: string;
  pool: string | null;
  snapshotId: string | null;
  evidence: Evidence;
  decision: Decision;
  refresh: 'cached' | 'collected' | 'pending' | 'failed';
}
export class SafetyScanner {
  private readonly inFlight = new Map<string, Promise<SafetyCache | null>>();
  constructor(
    private readonly store: SafetyStore,
    private readonly collect: (mint: string, pool: string | null, ttl: number) => Promise<Evidence>,
    private readonly now: () => number = Date.now,
  ) {}
  async scan(
    mint: string,
    pool: string | null = null,
    input: Policy = DEFAULT_POLICY,
  ): Promise<SafetyReport> {
    if (!address(mint) || (pool !== null && !address(pool))) throw new Error('INVALID_SCAN_INPUT');
    // Snapshot caller policy before awaiting IO; mutation cannot alter the persisted fingerprint.
    const policy = { ...validatePolicy(input) };
    const key = `solana:${mint}:${pool ?? 'none'}`;
    let cached = await this.store.read(key);
    let refresh: SafetyReport['refresh'] = 'cached';
    if (!cached || cached.refreshAfter <= cached.now || cached.expiresAt <= cached.now) {
      let work = this.inFlight.get(key);
      if (!work) {
        work = this.refresh(key, mint, pool, policy);
        this.inFlight.set(key, work);
      }
      try {
        const updated = await work;
        refresh = updated && updated.id !== cached?.id ? 'collected' : 'pending';
        cached = updated ?? cached;
      } catch {
        refresh = 'failed';
      } finally {
        if (this.inFlight.get(key) === work) this.inFlight.delete(key);
      }
    }
    let evidence: Evidence;
    try {
      evidence = cached
        ? validateEvidence(cached.evidence)
        : unknownEvidence(mint, pool, this.now(), policy.negativeCacheMs, 'RPC_UNAVAILABLE');
      if (evidence.mint !== mint || evidence.pool !== pool) throw new Error('INVALID_CACHE_SCOPE');
      if (
        cached &&
        cached.expiresAt.getTime() !==
          Math.min(...CHECKS.map((c) => Date.parse(evidence.checks[c].expiresAt)))
      )
        throw new Error('INVALID_CACHE_EXPIRY');
    } catch {
      evidence = unknownEvidence(
        mint,
        pool,
        this.now(),
        policy.negativeCacheMs,
        'INVALID_EVIDENCE',
      );
      cached = null;
      refresh = 'failed';
    }
    const decision = evaluate(evidence, policy, Math.max(this.now(), cached?.now.getTime() ?? 0));
    await this.store.record({
      key,
      snapshotId: cached?.id ?? null,
      mint,
      decimals: evidence.decimals,
      policy,
      policyVersion: policy.version,
      fingerprint: decision.policyFingerprint,
      decision,
      passed: decision.passed,
      score: decision.score,
    });
    return { mint, pool, snapshotId: cached?.id ?? null, evidence, decision, refresh };
  }
  private async refresh(
    key: string,
    mint: string,
    pool: string | null,
    policy: Policy,
  ): Promise<SafetyCache | null> {
    const lease = await this.store.acquire(key);
    if (!lease) return this.store.read(key);
    try {
      const latest = await this.store.read(key);
      if (latest && latest.refreshAfter > latest.now && latest.expiresAt > latest.now)
        return latest;
      let evidence: Evidence;
      try {
        evidence = validateEvidence(await this.collect(mint, pool, policy.maxAgeMs));
      } catch {
        evidence = unknownEvidence(
          mint,
          pool,
          this.now(),
          policy.negativeCacheMs,
          'RPC_UNAVAILABLE',
        );
      }
      if (evidence.mint !== mint || evidence.pool !== pool)
        throw new Error('INVALID_COLLECTOR_SCOPE');
      const failed = CHECKS.some((c) => evidence.checks[c].reason === 'RPC_UNAVAILABLE');
      const expiresAt = new Date(
        Math.min(...CHECKS.map((c) => Date.parse(evidence.checks[c].expiresAt))),
      ).toISOString();
      await this.store.save({
        key,
        mint,
        evidence,
        expiresAt,
        refreshMs: failed ? policy.negativeCacheMs : policy.refreshMs,
        lease,
      });
      return this.store.read(key);
    } finally {
      await this.store.release(key, lease);
    }
  }
}
