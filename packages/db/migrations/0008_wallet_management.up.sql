-- Provision legacy walletless bots with the offline wallet command before upgrading.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM bots WHERE wallet_id IS NULL) THEN
    RAISE EXCEPTION 'BOT-8 prerequisite: provision each walletless bot offline before migration 0008; see docs/wallets.md';
  END IF;
END $$;
ALTER TABLE bots ALTER COLUMN wallet_id SET NOT NULL;

-- Public accounting only. No keys, envelopes or filesystem paths belong in PostgreSQL.
CREATE TABLE wallet_spend_state (
  wallet_id uuid PRIMARY KEY REFERENCES wallets(id),
  usable_balance_lamports numeric(39,0) CHECK (usable_balance_lamports >= 0),
  observed_balance_lamports numeric(39,0) CHECK (observed_balance_lamports >= 0),
  balance_observed_at timestamptz,
  consumed_lamports numeric(39,0) NOT NULL DEFAULT 0 CHECK (consumed_lamports >= 0),
  CHECK ((balance_observed_at IS NULL) = (usable_balance_lamports IS NULL)),
  CHECK ((balance_observed_at IS NULL) = (observed_balance_lamports IS NULL))
);
INSERT INTO wallet_spend_state(wallet_id) SELECT id FROM wallets;
CREATE TABLE wallet_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  amount_lamports numeric(39,0) NOT NULL CHECK (amount_lamports > 0),
  fee_lamports numeric(39,0) NOT NULL CHECK (fee_lamports >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'released', 'settled')),
  settled_lamports numeric(39,0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(wallet_id, idempotency_key),
  CHECK ((status = 'settled' AND settled_lamports >= 0 AND settled_lamports <= amount_lamports + fee_lamports)
      OR (status <> 'settled' AND settled_lamports IS NULL))
);
CREATE INDEX wallet_reservations_pending ON wallet_reservations(wallet_id) WHERE status = 'pending';

CREATE FUNCTION guard_wallet_cap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE used numeric;
BEGIN
  SELECT s.consumed_lamports + COALESCE((SELECT sum(r.amount_lamports+r.fee_lamports)
    FROM wallet_reservations r WHERE r.wallet_id=NEW.id AND r.status='pending'),0)
    INTO used FROM wallet_spend_state s WHERE s.wallet_id=NEW.id;
  IF used IS NOT NULL AND (NEW.spend_cap_lamports IS NULL OR NEW.spend_cap_lamports < used) THEN
    RAISE EXCEPTION 'Wallet cap must be finite and cover consumed and reserved debit';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallets_guard_cap BEFORE UPDATE OF spend_cap_lamports ON wallets
  FOR EACH ROW EXECUTE FUNCTION guard_wallet_cap();
