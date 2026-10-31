/** Offline owner operation; this module is deliberately absent from the runtime barrel. */
import { recordAudit, setAuditActor } from '../audit.js';
import { withTransaction } from '../pool.js';
import type { Pool } from '../pool.js';
import type { PreparedWallet } from '@memebots/core';
import type { OfflineVault } from './vault.js';
import { fail, lamports, text, uuid, WalletError } from './validation.js';

/** Caller retains a stable opaque ID to retry after a crash. File precedes public metadata. */
export async function prepareWallet(
  pool: Pool,
  options: {
    walletId: string;
    label: string;
    spendCapLamports: bigint;
    vault: OfflineVault;
    encryptionKey: Uint8Array;
  },
): Promise<PreparedWallet> {
  const id = uuid(options.walletId).toLowerCase(),
    label = text(options.label),
    cap = lamports(options.spendCapLamports).toString();
  // Resume only by authenticated offline inspection. Never generate a replacement for an existing ID.
  let address: string;
  const existing = (await options.vault.listIds()).includes(id);
  if (existing) address = await options.vault.publicKey(id, options.encryptionKey);
  else address = await options.vault.provision(id, options.encryptionKey);
  try {
    return await withTransaction(pool, async (db) => {
      await setAuditActor(db, 'owner');
      const old = await db.query<{
        public_key: string;
        label: string;
        spend_cap_lamports: string;
        claimed_bot_id: string | null;
      }>(
        `SELECT w.*,p.claimed_bot_id FROM wallets w LEFT JOIN wallet_preparations p ON p.wallet_id=w.id WHERE w.id=$1 FOR UPDATE OF w`,
        [id],
      );
      if (old.rows[0]) {
        const w = old.rows[0];
        if (w.public_key !== address || w.label !== label || w.spend_cap_lamports !== cap)
          fail('RETRY_MISMATCH');
        if (
          w.claimed_bot_id ||
          (await db.query('SELECT id FROM bots WHERE wallet_id=$1', [id])).rowCount
        )
          fail('WALLET_ALREADY_ASSIGNED');
      } else {
        await db.query(
          'INSERT INTO wallets(id,label,public_key,spend_cap_lamports) VALUES($1,$2,$3,$4)',
          [id, label, address, cap],
        );
        await db.query('INSERT INTO wallet_spend_state(wallet_id) VALUES($1)', [id]);
      }
      await db.query(
        'INSERT INTO wallet_preparations(wallet_id) VALUES($1) ON CONFLICT DO NOTHING',
        [id],
      );
      await recordAudit(db, {
        actor: 'owner',
        action: 'wallet.prepared',
        entityType: 'wallet',
        entityId: id,
        details: { publicKey: address, spendCapLamports: cap },
      });
      return { id, label, publicKey: address, spendCapLamports: cap };
    });
  } catch (error) {
    // Retain the durable encrypted file on failure/ambiguous commit. Retry same ID/key, or inspect.
    if (error instanceof WalletError) throw error;
    return fail('PREPARE_FAILED_RETRY_SAME_ID');
  }
}
