-- Never remove wallets, associations or encrypted files on rollback.
-- Refuse to discard durable accounting after use; an owner must retain/reconcile it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM wallet_reservations) OR
     EXISTS (SELECT 1 FROM wallet_spend_state WHERE consumed_lamports <> 0) THEN
    RAISE EXCEPTION 'BOT-8 rollback blocked: preserve wallet accounting history before downgrade';
  END IF;
END $$;
DROP TRIGGER wallets_guard_cap ON wallets;
DROP FUNCTION guard_wallet_cap();
DROP TABLE wallet_reservations;
DROP TABLE wallet_spend_state;
ALTER TABLE bots ALTER COLUMN wallet_id DROP NOT NULL;
