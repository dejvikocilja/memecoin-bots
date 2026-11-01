-- BOT-16: global kill switch and losing-streak breaker.
--
-- The kill switch stops ALL buying across every bot. Selling is never blocked: exits,
-- stops and take-profits keep working, and "sell all" asks the exit manager to close
-- every open paper position with close reason 'kill_switch'.
--
-- Lock order (same as BOT-13/14/15): bots (by id) -> kill_switch -> orders (by id).

CREATE TABLE kill_switch (
  singleton    boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  engaged      boolean NOT NULL DEFAULT false,
  sell_all     boolean NOT NULL DEFAULT false,
  revision     bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  changed_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_by   text NOT NULL DEFAULT 'system' CHECK (length(changed_by) BETWEEN 1 AND 64),
  CONSTRAINT sell_all_needs_engaged CHECK (engaged OR NOT sell_all)
);
INSERT INTO kill_switch DEFAULT VALUES;
-- Exactly one row, forever: it cannot be deleted or truncated.
CREATE TRIGGER kill_switch_no_delete BEFORE DELETE ON kill_switch
  FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER kill_switch_no_truncate BEFORE TRUNCATE ON kill_switch
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Every change bumps the revision and is audited.
CREATE FUNCTION kill_switch_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.engaged, NEW.sell_all) IS NOT DISTINCT FROM ROW(OLD.engaged, OLD.sell_all) THEN
    RETURN OLD;
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.changed_at := clock_timestamp();
  NEW.changed_by := audit_actor();
  RETURN NEW;
END $$;
CREATE TRIGGER kill_switch_touch BEFORE UPDATE ON kill_switch
  FOR EACH ROW EXECUTE FUNCTION kill_switch_touch();

CREATE FUNCTION kill_switch_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log(actor, action, entity_type, entity_id, details)
  VALUES (audit_actor(),
          CASE WHEN NEW.engaged AND NOT OLD.engaged THEN 'kill_switch.engaged'
               WHEN OLD.engaged AND NOT NEW.engaged THEN 'kill_switch.released'
               ELSE 'kill_switch.changed' END,
          'kill_switch', 'global',
          jsonb_build_object('engaged', NEW.engaged, 'sellAll', NEW.sell_all,
                             'revision', NEW.revision::text));
  RETURN NEW;
END $$;
CREATE TRIGGER kill_switch_audit AFTER UPDATE ON kill_switch
  FOR EACH ROW WHEN (OLD.revision IS DISTINCT FROM NEW.revision)
  EXECUTE FUNCTION kill_switch_audit();

-- A paused bot may not buy, but its exits keep running (unlike mode 'off').
ALTER TABLE bots
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN pause_reason text CHECK (pause_reason IN ('losing_streak')),
  ADD CONSTRAINT pause_is_complete CHECK ((paused_at IS NULL) = (pause_reason IS NULL));

-- Why a buy may not proceed right now, or NULL. Shared by the triggers below and by
-- application code, so every path gives the same answer.
CREATE FUNCTION buy_block_reason(p_bot uuid) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  -- Keep the global lock order bot -> kill_switch. The bot key-share lock is the one a
  -- foreign-key check on orders takes anyway; taking it first means a writer that did not
  -- lock its bot cannot deadlock with an engage that holds every bot (found by the drill).
  PERFORM 1 FROM bots WHERE id = p_bot FOR KEY SHARE;
  -- FOR SHARE serializes with an engage in progress: either the engage commits first
  -- and this sees it, or this commits first and the engage cancels what it created.
  IF (SELECT engaged FROM kill_switch FOR SHARE) THEN RETURN 'KILL_SWITCH_ENGAGED'; END IF;
  IF EXISTS (SELECT 1 FROM bots WHERE id = p_bot AND paused_at IS NOT NULL) THEN
    RETURN 'BOT_PAUSED';
  END IF;
  RETURN NULL;
END $$;

-- The database itself refuses a new live buy order (vetoed records are still allowed).
CREATE FUNCTION buy_order_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reason text;
BEGIN
  IF NEW.side = 'buy' AND NEW.status IN ('pending', 'submitted', 'partially_filled')
     AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('pending', 'submitted', 'partially_filled')) THEN
    reason := buy_block_reason(NEW.bot_id);
    IF reason IS NOT NULL THEN
      RAISE EXCEPTION '%', reason USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_buy_gate BEFORE INSERT OR UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION buy_order_gate();

-- ...and a new execution attempt for a buy.
CREATE FUNCTION buy_attempt_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o record; reason text;
BEGIN
  SELECT side, bot_id INTO o FROM orders WHERE id = NEW.order_id;
  IF o.side = 'buy' THEN
    reason := buy_block_reason(o.bot_id);
    IF reason IS NOT NULL THEN
      RAISE EXCEPTION '%', reason USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paper_attempts_buy_gate BEFORE INSERT ON paper_execution_attempts
  FOR EACH ROW EXECUTE FUNCTION buy_attempt_gate();

-- Operator alerts reuse the BOT-12 incident/event outbox, so the same delivery path
-- (logger today, Telegram in BOT-26) carries them.
ALTER TABLE monitoring_incidents DROP CONSTRAINT monitoring_incidents_category_check;
ALTER TABLE monitoring_incidents ADD CONSTRAINT monitoring_incidents_category_check CHECK (category IN
  ('bot_stalled', 'rpc_unhealthy', 'discovery_unhealthy', 'kill_switch', 'losing_streak'));
ALTER TABLE monitoring_incidents DROP CONSTRAINT monitoring_incidents_code_check;
ALTER TABLE monitoring_incidents ADD CONSTRAINT monitoring_incidents_code_check CHECK (code IN
  ('heartbeat_stale', 'http', 'rpc', 'malformed', 'timeout', 'transport', 'unavailable',
   'engaged', 'sell_all', 'streak_limit'));
ALTER TABLE monitoring_events DROP CONSTRAINT monitoring_events_code_check;
ALTER TABLE monitoring_events ADD CONSTRAINT monitoring_events_code_check CHECK (code IN
  ('heartbeat_stale', 'http', 'rpc', 'malformed', 'timeout', 'transport', 'unavailable',
   'engaged', 'sell_all', 'streak_limit'));

-- Opens (p_open) or resolves an operator incident; at most one open per category+entity.
CREATE FUNCTION operator_alert(p_category text, p_entity text, p_open boolean, p_code text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE incident uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_category || ':' || p_entity, 12));
  SELECT id INTO incident FROM monitoring_incidents
    WHERE category = p_category AND entity_id = p_entity AND resolved_at IS NULL FOR UPDATE;
  IF p_open THEN
    IF incident IS NULL THEN
      INSERT INTO monitoring_incidents(category, entity_id, code) VALUES (p_category, p_entity, p_code)
        RETURNING id INTO incident;
      INSERT INTO monitoring_events(incident_id, transition, code) VALUES (incident, 'opened', p_code);
    ELSE
      UPDATE monitoring_incidents SET last_observed_at = clock_timestamp(), code = p_code WHERE id = incident;
    END IF;
  ELSIF incident IS NOT NULL THEN
    UPDATE monitoring_incidents SET last_observed_at = clock_timestamp(), resolved_at = clock_timestamp()
      WHERE id = incident;
    INSERT INTO monitoring_events(incident_id, transition, code) VALUES (incident, 'resolved', p_code);
  END IF;
END $$;

-- Losing-streak breaker: when a bot's consecutive losing closes reach its profile's
-- limit, pause it, audit and alert. Its pending buys are refused when they next try to
-- execute (BOT-13 records them as LOSING_STREAK_LIMIT vetoes; other buys get BOT_PAUSED).
-- Runs inside the settlement transaction that updated the streak, which holds the bot lock.
CREATE FUNCTION losing_streak_breaker() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE limit_n integer; bot record;
BEGIN
  SELECT b.id, b.paused_at, p.losing_streak_limit INTO bot
    FROM bots b JOIN risk_profiles p ON p.id = b.risk_profile_id WHERE b.id = NEW.bot_id FOR UPDATE OF b;
  limit_n := bot.losing_streak_limit;
  IF NEW.losses < limit_n OR bot.paused_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.losses >= limit_n THEN RETURN NEW; END IF;
  UPDATE bots SET paused_at = clock_timestamp(), pause_reason = 'losing_streak' WHERE id = NEW.bot_id;
  INSERT INTO audit_log(actor, action, entity_type, entity_id, details)
    VALUES ('system', 'bot.paused', 'bots', NEW.bot_id::text,
            jsonb_build_object('reason', 'losing_streak', 'losses', NEW.losses, 'limit', limit_n));
  PERFORM operator_alert('losing_streak', NEW.bot_id::text, true, 'streak_limit');
  RETURN NEW;
END $$;
CREATE TRIGGER risk_streaks_breaker AFTER INSERT OR UPDATE OF losses ON risk_streaks
  FOR EACH ROW EXECUTE FUNCTION losing_streak_breaker();
