import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { recordAudit } from '../audit.js';
import { withTransaction } from '../pool.js';
import type { Pool, Queryable } from '../pool.js';
import type { OfflineVault } from './vault.js';
import { fail, lamports, text, uuid, WalletError } from './validation.js';

export interface WalletView {
  botId: string;
  walletId: string;
  publicKey: string;
  spendCapLamports: string | null;
  paperBankrollLamports: string;
  observedBalanceLamports: string | null;
  usableBalanceLamports: string | null;
  balanceObservedAt: string | null;
  fresh: boolean;
  consumedLamports: string;
  reservedLamports: string;
  availableLamports: string;
}
interface AccountRow {
  bot_id: string;
  wallet_id: string;
  public_key: string;
  spend_cap_lamports: string | null;
  paper_bankroll_lamports: string;
  usable_balance_lamports: string | null;
  observed_balance_lamports: string | null;
  balance_observed_at: Date | null;
  consumed_lamports: string;
  reserved_lamports: string;
  fresh: boolean;
}
// One minute is a hard upper bound; callers may opt into a shorter age.
export const MAX_BALANCE_AGE_MS = 60_000;
function age(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_BALANCE_AGE_MS)
    fail('INVALID_BALANCE_AGE');
  return value;
}
async function account(
  db: Queryable,
  botId: string,
  maxAgeMs = MAX_BALANCE_AGE_MS,
): Promise<AccountRow> {
  uuid(botId);
  age(maxAgeMs);
  const { rows } = await db.query<AccountRow>(
    `SELECT b.id AS bot_id, w.id AS wallet_id, w.public_key, w.spend_cap_lamports,
      b.paper_bankroll_lamports, s.usable_balance_lamports, s.observed_balance_lamports,
      s.balance_observed_at, s.consumed_lamports,
      COALESCE((SELECT sum(amount_lamports + fee_lamports) FROM wallet_reservations r
        WHERE r.wallet_id=w.id AND r.status='pending'),0)::text AS reserved_lamports,
      COALESCE(s.balance_observed_at <= clock_timestamp() AND
        s.balance_observed_at >= clock_timestamp() - $2::double precision * interval '1 millisecond',false) AS fresh
     FROM bots b JOIN wallets w ON w.id=b.wallet_id JOIN wallet_spend_state s ON s.wallet_id=w.id
     WHERE b.id=$1`,
    [botId, maxAgeMs],
  );
  return rows[0] ?? fail('WALLET_NOT_FOUND');
}
function view(r: AccountRow): WalletView {
  const pending = BigInt(r.reserved_lamports),
    consumed = BigInt(r.consumed_lamports);
  const cap = r.spend_cap_lamports === null ? 0n : BigInt(r.spend_cap_lamports);
  const balance = r.usable_balance_lamports === null ? 0n : BigInt(r.usable_balance_lamports);
  const budget = cap - consumed - pending,
    physical = balance - pending;
  const available =
    r.fresh && budget > 0n && physical > 0n ? (budget < physical ? budget : physical) : 0n;
  return {
    botId: r.bot_id,
    walletId: r.wallet_id,
    publicKey: r.public_key,
    spendCapLamports: r.spend_cap_lamports,
    paperBankrollLamports: r.paper_bankroll_lamports,
    observedBalanceLamports: r.observed_balance_lamports,
    usableBalanceLamports: r.usable_balance_lamports,
    balanceObservedAt: r.balance_observed_at?.toISOString() ?? null,
    fresh: r.fresh,
    consumedLamports: r.consumed_lamports,
    reservedLamports: r.reserved_lamports,
    availableLamports: available.toString(),
  };
}
export async function getWalletView(
  db: Queryable,
  botId: string,
  maxAgeMs = MAX_BALANCE_AGE_MS,
): Promise<WalletView> {
  return view(await account(db, botId, maxAgeMs));
}
async function lock(db: Queryable, botId: string): Promise<void> {
  uuid(botId);
  const found = await db.query(
    `SELECT w.id FROM bots b JOIN wallets w ON w.id=b.wallet_id WHERE b.id=$1 FOR UPDATE OF b,w`,
    [botId],
  );
  if (!found.rowCount) fail('WALLET_NOT_FOUND');
}
async function safely<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof WalletError) throw error;
    return fail('DATABASE_OPERATION_FAILED');
  }
}

export interface NewBot {
  name: string;
  strategy: string;
  riskProfileId: string;
  paperBankrollLamports: bigint;
}
export interface ProvisionOptions {
  bot: { id: string } | NewBot;
  label: string;
  spendCapLamports: bigint;
  vault: OfflineVault;
  encryptionKey: Uint8Array;
  imported?: Uint8Array;
}
export interface ProvisionedWallet {
  botId: string;
  walletId: string;
  publicKey: string;
  spendCapLamports: string;
}
/** Works before 0008 for legacy recovery. Secret files are written before public DB metadata. */
export async function provisionBotWallet(
  pool: Pool,
  options: ProvisionOptions,
): Promise<ProvisionedWallet> {
  const cap = lamports(options.spendCapLamports);
  text(options.label);
  if ('id' in options.bot) uuid(options.bot.id);
  else {
    text(options.bot.name);
    text(options.bot.strategy, 40);
    text(options.bot.riskProfileId, 40);
    lamports(options.bot.paperBankrollLamports);
  }
  let createdFile: string | undefined;
  let committed = false;
  let commitAttempted = false;
  try {
    const result = await withTransaction(pool, async (db) => {
      const b = options.bot;
      if (!('id' in b))
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8))', [b.name]);
      const found = await db.query<{
        id: string;
        wallet_id: string | null;
        name: string;
        strategy: string;
        risk_profile_id: string;
        paper_bankroll_lamports: string;
      }>(
        `SELECT id,wallet_id,name,strategy,risk_profile_id,paper_bankroll_lamports FROM bots WHERE ${'id' in b ? 'id' : 'name'}=$1 FOR UPDATE`,
        ['id' in b ? b.id : b.name],
      );
      const existing = found.rows[0];
      if ('id' in b && !existing) fail('BOT_NOT_FOUND');
      if (
        existing &&
        !('id' in b) &&
        (existing.strategy !== b.strategy ||
          existing.risk_profile_id !== b.riskProfileId ||
          BigInt(existing.paper_bankroll_lamports) !== b.paperBankrollLamports)
      )
        fail('RETRY_MISMATCH');
      // A retry needs no key read or re-generation. Existing association is immutable here.
      if (existing?.wallet_id) {
        const { rows } = await db.query<{
          id: string;
          public_key: string;
          spend_cap_lamports: string | null;
          label: string;
        }>('SELECT id,public_key,spend_cap_lamports,label FROM wallets WHERE id=$1 FOR UPDATE', [
          existing.wallet_id,
        ]);
        const w = rows[0]!;
        const owned = (await options.vault.listIds()).includes(w.id);
        if (owned) {
          if (w.spend_cap_lamports !== cap.toString() || w.label !== options.label)
            fail('RETRY_MISMATCH');
          commitAttempted = true;
          return {
            botId: existing.id,
            walletId: w.id,
            publicKey: w.public_key,
            spendCapLamports: cap.toString(),
          };
        }
        // Legacy public metadata needs an explicit matching secret import, never a new phantom key.
        if (!options.imported) fail('LEGACY_IMPORT_REQUIRED');
        const address = await options.vault.provision(
          w.id,
          options.encryptionKey,
          options.imported,
        );
        createdFile = w.id;
        if (address !== w.public_key) fail('PUBLIC_KEY_MISMATCH');
        await db.query('UPDATE wallets SET label=$2,spend_cap_lamports=$3 WHERE id=$1', [
          w.id,
          options.label,
          cap.toString(),
        ]);
        await recordAudit(db, {
          actor: 'owner',
          action: 'wallet.provisioned',
          entityType: 'wallet',
          entityId: w.id,
          details: { botId: existing.id, publicKey: address, spendCapLamports: cap.toString() },
        });
        commitAttempted = true;
        return {
          botId: existing.id,
          walletId: w.id,
          publicKey: address,
          spendCapLamports: cap.toString(),
        };
      }
      const walletId = randomUUID();
      const address = await options.vault.provision(
        walletId,
        options.encryptionKey,
        options.imported,
      );
      createdFile = walletId;
      await db.query(
        'INSERT INTO wallets(id,label,public_key,spend_cap_lamports) VALUES($1,$2,$3,$4)',
        [walletId, options.label, address, cap.toString()],
      );
      let botId: string;
      if (existing) {
        botId = existing.id;
        await db.query('UPDATE bots SET wallet_id=$2 WHERE id=$1', [botId, walletId]);
      } else {
        const n = b as NewBot;
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO bots(name,strategy,risk_profile_id,paper_bankroll_lamports,wallet_id,mode) VALUES($1,$2,$3,$4,$5,'paper') RETURNING id`,
          [n.name, n.strategy, n.riskProfileId, n.paperBankrollLamports.toString(), walletId],
        );
        botId = inserted.rows[0]!.id;
      }
      // Accounting table does not exist during explicitly supported pre-0008 recovery.
      const table = await db.query<{ present: string | null }>(
        "SELECT to_regclass('public.wallet_spend_state')::text AS present",
      );
      if (table.rows[0]!.present)
        await db.query('INSERT INTO wallet_spend_state(wallet_id) VALUES($1)', [walletId]);
      await recordAudit(db, {
        actor: 'owner',
        action: 'wallet.provisioned',
        entityType: 'wallet',
        entityId: walletId,
        details: { botId, publicKey: address, spendCapLamports: cap.toString() },
      });
      commitAttempted = true;
      return { botId, walletId, publicKey: address, spendCapLamports: cap.toString() };
    });
    committed = true;
    return result;
  } catch (error) {
    if (error instanceof WalletError) throw error;
    return fail('PROVISION_FAILED');
  } finally {
    // A crash between durable file creation and DB commit can leave an orphan; inspectVault detects it.
    if (!committed && !commitAttempted && createdFile)
      await options.vault.removeUncommitted(createdFile);
  }
}
export async function inspectVault(
  db: Queryable,
  vault: OfflineVault,
): Promise<{ orphanIds: string[]; missingIds: string[] }> {
  const files = new Set(await vault.listIds());
  const { rows } = await db.query<{ id: string }>('SELECT id FROM wallets');
  const ids = new Set(rows.map((r) => r.id));
  return {
    orphanIds: [...files].filter((id) => !ids.has(id)),
    missingIds: [...ids].filter((id) => !files.has(id)),
  };
}

/** Conservative refresh: external deposits never replenish usable budget implicitly. */
export async function recordWalletBalance(
  pool: Pool,
  botId: string,
  balance: bigint,
  observedAt: Date,
): Promise<void> {
  lamports(balance);
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime()))
    fail('INVALID_BALANCE');
  return safely(() =>
    withTransaction(pool, async (db) => {
      await lock(db, botId);
      const r = await account(db, botId);
      const valid = await db.query<{ valid: boolean }>(
        `SELECT $1::timestamptz <= clock_timestamp() AND $1::timestamptz >= clock_timestamp()-interval '60 seconds' AS valid`,
        [observedAt],
      );
      if (!valid.rows[0]!.valid || (r.balance_observed_at && observedAt <= r.balance_observed_at))
        fail('STALE_BALANCE');
      await db.query(
        `UPDATE wallet_spend_state SET observed_balance_lamports=$2,
      usable_balance_lamports=LEAST(COALESCE(usable_balance_lamports,$2),$2),balance_observed_at=$3 WHERE wallet_id=$1`,
        [r.wallet_id, balance.toString(), observedAt],
      );
    }),
  );
}
/** Owner-only policy adjustment; raising cap does not replenish physical balance. */
export async function setWalletCap(pool: Pool, botId: string, cap: bigint): Promise<void> {
  lamports(cap);
  return safely(() =>
    withTransaction(pool, async (db) => {
      await lock(db, botId);
      const r = await account(db, botId);
      if (cap < BigInt(r.consumed_lamports) + BigInt(r.reserved_lamports)) fail('CAP_BELOW_USAGE');
      await db.query('UPDATE wallets SET spend_cap_lamports=$2 WHERE id=$1', [
        r.wallet_id,
        cap.toString(),
      ]);
      await recordAudit(db, {
        actor: 'owner',
        action: 'wallet.cap_changed',
        entityType: 'wallet',
        entityId: r.wallet_id,
        details: { before: r.spend_cap_lamports, after: cap.toString() },
      });
    }),
  );
}
export interface Reservation {
  id: string;
  status: 'pending' | 'released' | 'settled';
  amountLamports: string;
  feeLamports: string;
  settledLamports: string | null;
}
interface ReservationRow {
  id: string;
  status: Reservation['status'];
  amount_lamports: string;
  fee_lamports: string;
  settled_lamports: string | null;
}
const reservation = (r: ReservationRow): Reservation => ({
  id: r.id,
  status: r.status,
  amountLamports: r.amount_lamports,
  feeLamports: r.fee_lamports,
  settledLamports: r.settled_lamports,
});
export async function reserveWalletSpend(
  pool: Pool,
  botId: string,
  key: string,
  amount: bigint,
  fee: bigint,
): Promise<Reservation> {
  text(key);
  lamports(amount, true);
  lamports(fee);
  lamports(amount + fee, true);
  return safely(() =>
    withTransaction(pool, async (db) => {
      await lock(db, botId);
      const r = await account(db, botId);
      const prior = await db.query<ReservationRow>(
        'SELECT * FROM wallet_reservations WHERE wallet_id=$1 AND idempotency_key=$2',
        [r.wallet_id, key],
      );
      if (prior.rows[0]) {
        if (
          BigInt(prior.rows[0].amount_lamports) !== amount ||
          BigInt(prior.rows[0].fee_lamports) !== fee
        )
          fail('RETRY_MISMATCH');
        return reservation(prior.rows[0]);
      }
      if (!r.fresh) fail('BALANCE_UNAVAILABLE');
      if (amount + fee > BigInt(view(r).availableLamports)) fail('SPEND_LIMIT');
      const inserted = await db.query<ReservationRow>(
        `INSERT INTO wallet_reservations(wallet_id,idempotency_key,amount_lamports,fee_lamports) VALUES($1,$2,$3,$4) RETURNING *`,
        [r.wallet_id, key, amount.toString(), fee.toString()],
      );
      return reservation(inserted.rows[0]!);
    }),
  );
}
async function finish(
  db: PoolClient,
  botId: string,
  id: string,
  actual: bigint | null,
): Promise<Reservation> {
  await lock(db, botId);
  const r = await account(db, botId);
  const found = await db.query<ReservationRow>(
    'SELECT * FROM wallet_reservations WHERE id=$1 AND wallet_id=$2 FOR UPDATE',
    [uuid(id), r.wallet_id],
  );
  const prior = found.rows[0] ?? fail('RESERVATION_NOT_FOUND');
  const status = actual === null ? 'released' : 'settled';
  if (prior.status !== 'pending') {
    if (
      prior.status !== status ||
      (actual !== null && prior.settled_lamports !== actual.toString())
    )
      fail('RESERVATION_FINALIZED');
    return reservation(prior);
  }
  if (actual !== null) {
    if (actual > BigInt(prior.amount_lamports) + BigInt(prior.fee_lamports))
      fail('SETTLEMENT_EXCEEDS_RESERVATION');
    await db.query(
      `UPDATE wallet_spend_state SET consumed_lamports=consumed_lamports+$2,
      usable_balance_lamports=GREATEST(0,usable_balance_lamports-$2) WHERE wallet_id=$1`,
      [r.wallet_id, actual.toString()],
    );
  }
  const updated = await db.query<ReservationRow>(
    'UPDATE wallet_reservations SET status=$2,settled_lamports=$3,updated_at=now() WHERE id=$1 RETURNING *',
    [id, status, actual?.toString() ?? null],
  );
  return reservation(updated.rows[0]!);
}
export async function releaseWalletSpend(
  pool: Pool,
  botId: string,
  id: string,
): Promise<Reservation> {
  return safely(() => withTransaction(pool, (db) => finish(db, botId, id, null)));
}
export async function settleWalletSpend(
  pool: Pool,
  botId: string,
  id: string,
  actualDebitIncludingFees: bigint,
): Promise<Reservation> {
  lamports(actualDebitIncludingFees);
  return safely(() =>
    withTransaction(pool, (db) => finish(db, botId, id, actualDebitIncludingFees)),
  );
}
