import { randomUUID } from 'node:crypto';
import { recordAudit } from './audit.js';
import { withTransaction } from './pool.js';
import type { Pool } from './pool.js';

export interface SafetyCache {
  id: string;
  evidence: unknown;
  expiresAt: Date;
  refreshAfter: Date;
  now: Date;
}
export interface SafetyLease {
  id: string;
  startedAt: Date;
}
/** Database-clock lease with fencing. A crashed refresh can be reclaimed after 30 seconds. */
export class SafetyStore {
  constructor(private readonly pool: Pool) {}
  async read(key: string): Promise<SafetyCache | null> {
    const { rows } = await this.pool.query<{
      id: string;
      evidence: unknown;
      expires_at: Date;
      refresh_after: Date;
      now: Date;
    }>(
      `SELECT s.id,s.evidence,s.expires_at,c.refresh_after,clock_timestamp() AS now
       FROM token_safety_cache c JOIN token_safety_snapshots s ON s.id=c.snapshot_id WHERE c.cache_key=$1`,
      [key],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          evidence: row.evidence,
          expiresAt: row.expires_at,
          refreshAfter: row.refresh_after,
          now: row.now,
        }
      : null;
  }
  async acquire(key: string): Promise<SafetyLease | null> {
    const { rows } = await this.pool.query<{ lease_id: string; started_at: Date }>(
      `INSERT INTO token_safety_leases(cache_key,lease_id,started_at,lease_until)
       VALUES($1,$2,clock_timestamp(),clock_timestamp()+interval '30 seconds')
       ON CONFLICT(cache_key) DO UPDATE SET lease_id=EXCLUDED.lease_id,started_at=EXCLUDED.started_at,lease_until=EXCLUDED.lease_until
       WHERE token_safety_leases.lease_until <= clock_timestamp() RETURNING lease_id,started_at`,
      [key, randomUUID()],
    );
    return rows[0] ? { id: rows[0].lease_id, startedAt: rows[0].started_at } : null;
  }
  async release(key: string, lease: SafetyLease): Promise<void> {
    await this.pool.query('DELETE FROM token_safety_leases WHERE cache_key=$1 AND lease_id=$2', [
      key,
      lease.id,
    ]);
  }
  async save(input: {
    key: string;
    mint: string;
    evidence: unknown;
    expiresAt: string;
    refreshMs: number;
    lease: SafetyLease;
  }): Promise<string | null> {
    if (
      !Number.isSafeInteger(input.refreshMs) ||
      input.refreshMs < 1 ||
      input.refreshMs > 300000 ||
      !Number.isFinite(Date.parse(input.expiresAt))
    )
      throw new Error('INVALID_SAFETY_CACHE');
    return withTransaction(this.pool, async (db) => {
      const lease = await db.query<{ started_at: Date }>(
        'SELECT started_at FROM token_safety_leases WHERE cache_key=$1 AND lease_id=$2 AND lease_until>clock_timestamp() FOR UPDATE',
        [input.key, input.lease.id],
      );
      if (!lease.rowCount) return null;
      // Never trust a caller to move a refresh ahead of database time.
      const startedAt = lease.rows[0]!.started_at;
      const current = await db.query(
        'SELECT 1 FROM token_safety_cache WHERE cache_key=$1 AND refresh_started_at >= $2',
        [input.key, startedAt],
      );
      if (current.rowCount || Date.parse(input.expiresAt) <= startedAt.getTime()) return null;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO token_safety_snapshots(cache_key,schema_version,mint,refresh_started_at,expires_at,evidence)
         VALUES($1,1,$2,$3,$4,$5) RETURNING id`,
        [input.key, input.mint, startedAt, input.expiresAt, JSON.stringify(input.evidence)],
      );
      const id = rows[0]!.id;
      await db.query(
        `INSERT INTO token_safety_cache(cache_key,snapshot_id,refresh_started_at,refresh_after)
        VALUES($1,$2,$3,LEAST($4::timestamptz,clock_timestamp()+$5 * interval '1 millisecond'))
        ON CONFLICT(cache_key) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,refresh_started_at=EXCLUDED.refresh_started_at,refresh_after=EXCLUDED.refresh_after
        WHERE token_safety_cache.refresh_started_at<EXCLUDED.refresh_started_at`,
        [input.key, id, startedAt, input.expiresAt, input.refreshMs],
      );
      await recordAudit(db, {
        actor: 'system',
        action: 'safety.evidence_collected',
        entityType: 'token',
        entityId: input.mint,
        details: { snapshotId: id, schemaVersion: 1 },
      });
      await db.query('DELETE FROM token_safety_leases WHERE cache_key=$1 AND lease_id=$2', [
        input.key,
        input.lease.id,
      ]);
      return id;
    });
  }
  async record(input: {
    key: string;
    snapshotId: string | null;
    mint: string;
    decimals: number | null;
    policy: unknown;
    policyVersion: string;
    fingerprint: string;
    decision: unknown;
    passed: boolean;
    score: number;
  }): Promise<void> {
    await withTransaction(this.pool, async (db) => {
      await db.query(
        `INSERT INTO token_safety_evaluations(cache_key,snapshot_id,policy_version,policy_fingerprint,policy,decision) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          input.key,
          input.snapshotId,
          input.policyVersion,
          input.fingerprint,
          JSON.stringify(input.policy),
          JSON.stringify(input.decision),
        ],
      );
      if (input.decimals !== null) {
        await db.query(
          `INSERT INTO tokens(mint,decimals) VALUES($1,$2) ON CONFLICT(mint) DO NOTHING`,
          [input.mint, input.decimals],
        );
        await db.query(
          `UPDATE tokens SET safety_passed=$2,safety_score=$3,safety_details=$4,safety_checked_at=clock_timestamp() WHERE mint=$1`,
          [
            input.mint,
            input.passed,
            input.score,
            JSON.stringify({ policyFingerprint: input.fingerprint, snapshotId: input.snapshotId }),
          ],
        );
      }
      await recordAudit(db, {
        actor: 'system',
        action: input.passed ? 'safety.passed' : 'safety.denied',
        entityType: 'token',
        entityId: input.mint,
        details: {
          policyFingerprint: input.fingerprint,
          snapshotId: input.snapshotId,
          decision: input.decision,
        },
      });
    });
  }
}
