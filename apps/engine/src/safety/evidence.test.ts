import { describe, expect, it } from 'vitest';
import { CHECKS, DEFAULT_POLICY, evaluate, validateEvidence, validatePolicy } from './evidence.js';
import { fixtureAddress, goodScenario, rugScenario, unknownScenario } from './fixtures.js';
const now = 1800000000000;
describe('mandatory engineering safety policy', () => {
  it('passes the explicitly synthetic good scenario and labels it', () => {
    expect(evaluate(goodScenario(now), DEFAULT_POLICY, now)).toMatchObject({
      passed: true,
      score: 100,
      scenario: true,
    });
  });
  for (const check of CHECKS) {
    it(`${check}: realistic adverse evidence fails regardless of relaxed score`, () => {
      const d = evaluate(rugScenario(check, now), { ...DEFAULT_POLICY, minScore: 1 }, now);
      expect(d.passed).toBe(false);
      expect(d.checks[check].status).toBe('fail');
    });
    it(`${check}: unknown and expired evidence cannot pass`, () => {
      expect(
        evaluate(unknownScenario(check, now), { ...DEFAULT_POLICY, minScore: 1 }, now).checks[check]
          .status,
      ).toBe('unknown');
      const e = goodScenario(now);
      e.checks[check].expiresAt = new Date(now + 1).toISOString();
      expect(evaluate(e, DEFAULT_POLICY, now + 1)).toMatchObject({
        passed: false,
        checks: { [check]: { reason: 'EXPIRED' } },
      });
    });
  }
  it('reruns thresholds and fingerprints for the same evidence', () => {
    const e = goodScenario(now);
    const first = evaluate(e, DEFAULT_POLICY, now);
    const strict = evaluate(e, { ...DEFAULT_POLICY, maxOwnerBps: 499 }, now);
    expect(first.passed).toBe(true);
    expect(strict.passed).toBe(false);
    expect(first.policyFingerprint).not.toBe(strict.policyFingerprint);
  });
  it('aggregates owners exactly beyond 2^53 and never treats top20 as complete', () => {
    const e = goodScenario(now);
    const f = e.checks.holders.facts!;
    f.complete = false;
    f.developerAttributionVerified = false;
    f.developerOwner = null;
    expect(evaluate(e, DEFAULT_POLICY, now).checks.holders).toMatchObject({ status: 'unknown' });
    f.owners = [
      { owner: fixtureAddress(2), amountRaw: '5000000000000000001' },
      { owner: fixtureAddress(2), amountRaw: '5000000000000000000' },
    ];
    expect(evaluate(e, DEFAULT_POLICY, now).checks.holders).toMatchObject({ status: 'fail' });
    f.supplyRaw = '0';
    expect(evaluate(e, DEFAULT_POLICY, now).checks.holders.status).toBe('unknown');
  });
  it('requires corroborated developer attribution and complete supply enumeration', () => {
    const e = goodScenario(now);
    const f = e.checks.holders.facts!;
    f.developerAttributionVerified = false;
    expect(evaluate(e, DEFAULT_POLICY, now).checks.holders.status).toBe('unknown');
    f.developerAttributionVerified = true;
    (f.owners as unknown[]).pop();
    expect(evaluate(e, DEFAULT_POLICY, now).checks.holders.status).toBe('unknown');
  });
  it('rejects fake burn labels, expired locks, incomplete bundle coverage and simulation shortcuts', () => {
    const e = goodScenario(now);
    const lp = e.checks.lp.facts!;
    lp.mechanism = 'burn';
    lp.mappingVerified = false;
    expect(evaluate(e, DEFAULT_POLICY, now).checks.lp.status).toBe('unknown');
    lp.mappingVerified = true;
    lp.mechanism = 'lock';
    lp.lockedUntil = new Date(now - 1).toISOString();
    expect(evaluate(e, DEFAULT_POLICY, now).checks.lp.status).toBe('fail');
    e.checks.bundle.facts!.coverageComplete = false;
    expect(evaluate(e, DEFAULT_POLICY, now).checks.bundle.status).toBe('unknown');
    e.checks.sell.facts!.walletBalanceRaw = '0';
    expect(evaluate(e, DEFAULT_POLICY, now).checks.sell.status).toBe('unknown');
    e.checks.sell.facts!.walletBalanceRaw = '99999999999999999';
    e.checks.sell.facts!.routeVerified = false;
    expect(evaluate(e, DEFAULT_POLICY, now).checks.sell.status).toBe('unknown');
  });
  it('validates policy/evidence at runtime including unknown fields and provenance', () => {
    expect(() => validatePolicy({ ...DEFAULT_POLICY, requiredChecks: [] })).toThrow(
      'INVALID_POLICY',
    );
    const e = goodScenario(now);
    e.checks.lp.provenance.source = 'solana_rpc';
    expect(() => validateEvidence(e)).toThrow('INVALID_EVIDENCE');
    const other = goodScenario(now);
    other.checks.sell.facts!.amountRaw = 9007199254740992;
    expect(() => validateEvidence(other)).toThrow('INVALID_EVIDENCE');
    const badDate = goodScenario(now);
    badDate.checks.lp.observedAt = 'invalid';
    expect(() => validateEvidence(badDate)).toThrow('INVALID_EVIDENCE');
  });
  it('requires recorded chain context and rejects live coverage upgrades from top20', () => {
    const e = goodScenario(now);
    e.checks.sell.provenance.slot = null;
    expect(evaluate(e, DEFAULT_POLICY, now).checks.sell.status).toBe('unknown');
    const holders = e.checks.holders;
    holders.provenance = {
      source: 'solana_rpc',
      reference: 'classic_spl_rpc_v1',
      slot: 100,
      commitment: 'confirmed',
    };
    holders.coverage = 'top20_accounts';
    expect(() => validateEvidence(e)).toThrow('INVALID_EVIDENCE');
  });
  it('only passes a synthetic burn with verified mapping and withdrawal restriction', () => {
    const e = goodScenario(now);
    e.checks.lp.facts!.mechanism = 'burn';
    expect(evaluate(e, DEFAULT_POLICY, now).checks.lp.status).toBe('pass');
    e.checks.lp.facts!.withdrawalRestricted = false;
    expect(evaluate(e, DEFAULT_POLICY, now).checks.lp.status).toBe('unknown');
  });
});
