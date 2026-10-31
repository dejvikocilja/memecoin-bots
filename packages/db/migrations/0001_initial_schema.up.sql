-- BOT-5: initial data model.
--
-- Conventions
--   * Token and SOL amounts are integers in raw units (token base units, lamports),
--     stored as numeric(39,0) so a u64/u128 never overflows. Never floats.
--   * Prices and fractions are numeric (exact decimals).
--   * Every bot, position, order and fill records the mode it ran in, so paper
--     and live results never mix.
--   * Private keys are never stored in the database (spec section 8).

-- Risk profiles: the numbers behind Conservative / Balanced / Aggressive / Degen.
-- The rows are seeded and tuned by BOT-10; the hard limits below cannot be
-- configured away (spec section 5).
CREATE TABLE risk_profiles (
  id                         text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{1,39}$'),
  display_name               text NOT NULL,
  position_fraction          numeric NOT NULL CHECK (position_fraction > 0 AND position_fraction <= 0.05),
  stop_loss_fraction         numeric NOT NULL CHECK (stop_loss_fraction > 0 AND stop_loss_fraction < 1),
  -- [{"atGain": 0.15, "sellFraction": 0.5}, ...]: sell a fraction once price is up atGain.
  take_profit_ladder         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(take_profit_ladder) = 'array'),
  trailing_stop_fraction     numeric CHECK (trailing_stop_fraction IS NULL OR (trailing_stop_fraction > 0 AND trailing_stop_fraction < 1)),
  min_reward_risk            numeric NOT NULL CHECK (min_reward_risk > 0),
  max_open_positions         integer NOT NULL CHECK (max_open_positions > 0),
  daily_loss_limit_fraction  numeric NOT NULL CHECK (daily_loss_limit_fraction > 0 AND daily_loss_limit_fraction < 1),
  max_slippage_bps           integer NOT NULL CHECK (max_slippage_bps > 0 AND max_slippage_bps <= 5000),
  min_liquidity_usd          numeric NOT NULL CHECK (min_liquidity_usd >= 0),
  min_safety_score           integer NOT NULL CHECK (min_safety_score BETWEEN 1 AND 100),
  max_hold_minutes           integer NOT NULL CHECK (max_hold_minutes > 0),
  losing_streak_limit        integer NOT NULL CHECK (losing_streak_limit > 0),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Hot wallets: public keys only. Encrypted keys live outside the database (BOT-4, BOT-8).
CREATE TABLE wallets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                 text NOT NULL,
  public_key            text NOT NULL UNIQUE CHECK (public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  spend_cap_lamports    numeric(39,0) CHECK (spend_cap_lamports IS NULL OR spend_cap_lamports >= 0),
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Bots: one strategy + one risk profile + (for live) one wallet + a mode.
CREATE TABLE bots (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  strategy                  text NOT NULL CHECK (strategy ~ '^[a-z][a-z0-9_]{1,39}$'),
  strategy_params           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(strategy_params) = 'object'),
  risk_profile_id           text NOT NULL REFERENCES risk_profiles (id),
  -- One wallet per bot; a wallet serves at most one bot.
  wallet_id                 uuid UNIQUE REFERENCES wallets (id),
  mode                      text NOT NULL DEFAULT 'paper' CHECK (mode IN ('off', 'paper', 'live')),
  paper_bankroll_lamports   numeric(39,0) NOT NULL DEFAULT 0 CHECK (paper_bankroll_lamports >= 0),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_bot_needs_wallet CHECK (mode <> 'live' OR wallet_id IS NOT NULL)
);

-- Tokens seen by the engine, with the latest safety scan (BOT-9 fills these in).
CREATE TABLE tokens (
  mint                 text PRIMARY KEY CHECK (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  symbol               text,
  name                 text,
  decimals             smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  safety_passed        boolean,
  safety_score         integer CHECK (safety_score IS NULL OR safety_score BETWEEN 0 AND 100),
  safety_details       jsonb,
  safety_checked_at    timestamptz
);

-- Positions: an open or closed holding of one token by one bot.
CREATE TABLE positions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id                   uuid NOT NULL REFERENCES bots (id),
  token_mint               text NOT NULL REFERENCES tokens (mint),
  mode                     text NOT NULL CHECK (mode IN ('paper', 'live')),
  status                   text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at                timestamptz NOT NULL DEFAULT now(),
  closed_at                timestamptz,
  close_reason             text CHECK (close_reason IS NULL OR close_reason IN
                             ('stop_loss', 'take_profit', 'trailing_stop', 'time_stop', 'kill_switch', 'manual', 'strategy_exit')),
  -- Average entry price in SOL per whole token.
  entry_price_sol          numeric NOT NULL CHECK (entry_price_sol > 0),
  quantity_raw             numeric(39,0) NOT NULL CHECK (quantity_raw > 0),
  remaining_raw            numeric(39,0) NOT NULL CHECK (remaining_raw >= 0),
  cost_lamports            numeric(39,0) NOT NULL CHECK (cost_lamports >= 0),
  stop_price_sol           numeric NOT NULL CHECK (stop_price_sol >= 0),
  -- Highest price since entry, for the trailing stop.
  high_water_price_sol     numeric NOT NULL CHECK (high_water_price_sol > 0),
  -- Take-profit steps still to fire, same shape as risk_profiles.take_profit_ladder.
  take_profit_remaining    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(take_profit_remaining) = 'array'),
  realized_pnl_lamports    numeric(39,0) NOT NULL DEFAULT 0,
  CONSTRAINT remaining_not_above_quantity CHECK (remaining_raw <= quantity_raw),
  CONSTRAINT closed_positions_are_complete CHECK (
    (status = 'open' AND closed_at IS NULL AND close_reason IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL AND close_reason IS NOT NULL AND remaining_raw = 0)
  )
);

-- At most one open position per bot and token.
CREATE UNIQUE INDEX positions_one_open_per_bot_token ON positions (bot_id, token_mint) WHERE status = 'open';
CREATE INDEX positions_open ON positions (bot_id) WHERE status = 'open';

-- Orders: every buy or sell the risk manager approved or vetoed.
CREATE TABLE orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Idempotency key: retrying the same order never creates a second one.
  client_order_id      text NOT NULL UNIQUE,
  bot_id               uuid NOT NULL REFERENCES bots (id),
  position_id          uuid REFERENCES positions (id),
  token_mint           text NOT NULL REFERENCES tokens (mint),
  side                 text NOT NULL CHECK (side IN ('buy', 'sell')),
  mode                 text NOT NULL CHECK (mode IN ('paper', 'live')),
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN
                         ('vetoed', 'pending', 'submitted', 'partially_filled', 'filled', 'failed', 'cancelled')),
  -- Lamports for a buy, raw token units for a sell.
  amount_in_raw        numeric(39,0) NOT NULL CHECK (amount_in_raw > 0),
  max_slippage_bps     integer NOT NULL CHECK (max_slippage_bps > 0),
  reason               text NOT NULL,
  veto_reason          text,
  failure_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vetoed_orders_say_why CHECK ((status = 'vetoed') = (veto_reason IS NOT NULL))
);

CREATE INDEX orders_bot_created ON orders (bot_id, created_at DESC);
CREATE INDEX orders_position ON orders (position_id) WHERE position_id IS NOT NULL;

-- Fills: what actually happened. Append-only; this is also the tax record (BOT-2).
CREATE TABLE fills (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 uuid NOT NULL REFERENCES orders (id),
  token_mint               text NOT NULL REFERENCES tokens (mint),
  mode                     text NOT NULL CHECK (mode IN ('paper', 'live')),
  executed_at              timestamptz NOT NULL,
  token_amount_raw         numeric(39,0) NOT NULL CHECK (token_amount_raw > 0),
  sol_amount_lamports      numeric(39,0) NOT NULL CHECK (sol_amount_lamports >= 0),
  price_sol                numeric NOT NULL CHECK (price_sol > 0),
  price_usd                numeric CHECK (price_usd IS NULL OR price_usd > 0),
  sol_usd_rate             numeric CHECK (sol_usd_rate IS NULL OR sol_usd_rate > 0),
  network_fee_lamports     numeric(39,0) NOT NULL DEFAULT 0 CHECK (network_fee_lamports >= 0),
  priority_fee_lamports    numeric(39,0) NOT NULL DEFAULT 0 CHECK (priority_fee_lamports >= 0),
  slippage_bps             integer,
  wallet_public_key        text,
  tx_signature             text UNIQUE,
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- A live fill must say which wallet and which transaction; a paper fill has neither.
  CONSTRAINT live_fills_are_traceable CHECK (
    (mode = 'live' AND wallet_public_key IS NOT NULL AND tx_signature IS NOT NULL)
    OR (mode = 'paper' AND tx_signature IS NULL)
  )
);

CREATE INDEX fills_order ON fills (order_id);
CREATE INDEX fills_executed_at ON fills (executed_at);

-- Audit log: every order, veto and config change (spec section 8). Append-only.
CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL CHECK (length(actor) > 0),
  action        text NOT NULL CHECK (length(action) > 0),
  entity_type   text NOT NULL,
  entity_id     text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_log_entity ON audit_log (entity_type, entity_id, at);

-- Append-only enforcement for fills and the audit log.
CREATE FUNCTION reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER fills_append_only BEFORE UPDATE OR DELETE ON fills
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER fills_no_truncate BEFORE TRUNCATE ON fills
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Keep updated_at honest.
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER risk_profiles_touch BEFORE UPDATE ON risk_profiles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER bots_touch BEFORE UPDATE ON bots FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
