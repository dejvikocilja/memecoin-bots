-- BOT-12: durable leases, incident state + append-only events/outbox, and canonical audits.
CREATE TABLE bot_heartbeats (
  bot_id uuid PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  owner_id uuid,
  generation bigint NOT NULL DEFAULT 0,
  expected boolean NOT NULL,
  expected_since timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz,
  progress_kind text NOT NULL DEFAULT 'scaffold' CHECK (progress_kind IN ('scaffold', 'strategy'))
);
CREATE INDEX bot_heartbeats_overdue ON bot_heartbeats ((COALESCE(heartbeat_at, expected_since))) WHERE expected;
INSERT INTO bot_heartbeats (bot_id, expected) SELECT id, mode = 'paper' FROM bots;

CREATE TABLE monitoring_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL CHECK (category IN ('bot_stalled', 'rpc_unhealthy', 'discovery_unhealthy')),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 64),
  first_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  code text NOT NULL CHECK (code IN ('heartbeat_stale', 'http', 'rpc', 'malformed', 'timeout', 'transport', 'unavailable'))
);
CREATE UNIQUE INDEX monitoring_open_incident ON monitoring_incidents(category, entity_id) WHERE resolved_at IS NULL;
CREATE TABLE monitoring_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES monitoring_incidents(id),
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  transition text NOT NULL CHECK (transition IN ('opened', 'resolved')),
  code text NOT NULL CHECK (code IN ('heartbeat_stale', 'http', 'rpc', 'malformed', 'timeout', 'transport', 'unavailable'))
);
CREATE TRIGGER monitoring_events_append_only BEFORE UPDATE OR DELETE ON monitoring_events FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER monitoring_events_no_truncate BEFORE TRUNCATE ON monitoring_events FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
-- Separate delivery receipts keep the immutable event stream usable as a restart-safe outbox.
CREATE TABLE monitoring_deliveries (
  event_id bigint PRIMARY KEY REFERENCES monitoring_events(id),
  delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  channel text NOT NULL DEFAULT 'logger' CHECK (channel = 'logger')
);
CREATE TABLE monitoring_health (
  category text NOT NULL CHECK (category IN ('rpc_unhealthy', 'discovery_unhealthy')),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 64),
  status text NOT NULL CHECK (status IN ('healthy', 'unhealthy')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  code text NOT NULL CHECK (code IN ('http', 'rpc', 'malformed', 'timeout', 'transport', 'unavailable')),
  PRIMARY KEY(category, entity_id)
);
CREATE TABLE runtime_config_snapshots (
  service text PRIMARY KEY CHECK (service IN ('engine', 'monitor')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  policy jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION monitoring_transition(p_category text, p_entity text, p_failed boolean, p_code text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE incident uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_category || ':' || p_entity, 12));
  IF p_category <> 'bot_stalled' THEN
    INSERT INTO monitoring_health(category, entity_id, status, code) VALUES(p_category, p_entity, CASE WHEN p_failed THEN 'unhealthy' ELSE 'healthy' END, p_code)
    ON CONFLICT(category, entity_id) DO UPDATE SET status = EXCLUDED.status, code = EXCLUDED.code, observed_at = clock_timestamp();
  END IF;
  SELECT id INTO incident FROM monitoring_incidents WHERE category = p_category AND entity_id = p_entity AND resolved_at IS NULL FOR UPDATE;
  IF p_failed THEN
    IF incident IS NULL THEN
      INSERT INTO monitoring_incidents(category, entity_id, code) VALUES(p_category, p_entity, p_code) RETURNING id INTO incident;
      INSERT INTO monitoring_events(incident_id, transition, code) VALUES(incident, 'opened', p_code);
    ELSE
      UPDATE monitoring_incidents SET last_observed_at = clock_timestamp(), code = p_code WHERE id = incident;
    END IF;
  ELSIF incident IS NOT NULL THEN
    UPDATE monitoring_incidents SET last_observed_at = clock_timestamp(), resolved_at = clock_timestamp() WHERE id = incident;
    INSERT INTO monitoring_events(incident_id, transition, code) VALUES(incident, 'resolved', p_code);
  END IF;
END;
$$;
CREATE FUNCTION monitoring_scan() RETURNS void LANGUAGE plpgsql AS $$
DECLARE lease record;
BEGIN
  -- Include active bots which have never received a first heartbeat, even after a crash.
  FOR lease IN SELECT h.*, b.mode FROM bot_heartbeats h JOIN bots b ON b.id = h.bot_id LOOP
    PERFORM monitoring_transition('bot_stalled', lease.bot_id::text,
      lease.mode = 'paper' AND lease.expected AND COALESCE(lease.heartbeat_at, lease.expected_since) <= clock_timestamp() - interval '40 seconds', 'heartbeat_stale');
  END LOOP;
  -- Bot deletion cascades its lease, but incident/event history remains. Close only
  -- orphaned bot incidents; other bots and provider incidents retain their state.
  FOR lease IN SELECT i.entity_id FROM monitoring_incidents i
    WHERE i.category = 'bot_stalled' AND i.resolved_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM bots b WHERE b.id::text = i.entity_id) LOOP
    PERFORM monitoring_transition('bot_stalled', lease.entity_id, false, 'heartbeat_stale');
  END LOOP;
END;
$$;
-- One bounded statement scans and returns newly durable events, so provider work cannot delay stall emission.
CREATE FUNCTION monitoring_poll() RETURNS TABLE(id text, "incidentId" uuid, category text, "entityId" text, transition text, code text)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM monitoring_scan();
  RETURN QUERY SELECT e.id::text, e.incident_id, i.category, i.entity_id, e.transition, e.code
    FROM monitoring_events e JOIN monitoring_incidents i ON i.id = e.incident_id
    LEFT JOIN monitoring_deliveries d ON d.event_id = e.id
    WHERE d.event_id IS NULL ORDER BY e.id LIMIT 100;
END;
$$;
CREATE FUNCTION monitoring_bot_expectation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO bot_heartbeats(bot_id, expected) VALUES (NEW.id, NEW.mode = 'paper');
  ELSIF NEW.mode IS DISTINCT FROM OLD.mode THEN
    UPDATE bot_heartbeats SET expected = NEW.mode = 'paper', expected_since = clock_timestamp(), heartbeat_at = NULL,
      owner_id = NULL, generation = generation + 1 WHERE bot_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bots_monitoring AFTER INSERT OR UPDATE ON bots FOR EACH ROW EXECUTE FUNCTION monitoring_bot_expectation();

-- These selectors never serialize arbitrary rows, credentials, strategy_params or free-text reasons.
CREATE FUNCTION audit_safe_policy(kind text, value jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result jsonb := '{}'::jsonb; field text; fields text[];
BEGIN
  fields := CASE kind
    WHEN 'bots' THEN ARRAY['strategy', 'risk_profile_id', 'wallet_id', 'mode', 'paper_bankroll_lamports']
    WHEN 'wallets' THEN ARRAY['spend_cap_lamports']
    WHEN 'risk_profiles' THEN ARRAY['position_fraction', 'stop_loss_fraction', 'trailing_stop_fraction', 'min_reward_risk', 'max_open_positions', 'daily_loss_limit_fraction', 'max_slippage_bps', 'min_liquidity_usd', 'min_safety_score', 'max_hold_minutes', 'losing_streak_limit', 'safety_mode']
    ELSE ARRAY[]::text[] END;
  FOREACH field IN ARRAY fields LOOP
    IF value ? field THEN result := result || jsonb_build_object(field, value->field); END IF;
  END LOOP;
  IF kind = 'risk_profiles' THEN
    -- Only bounded numeric ladder fields; legacy malformed/free-text JSON is never copied.
    IF jsonb_array_length(value->'take_profit_ladder') <= 16 AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(value->'take_profit_ladder') step
      WHERE jsonb_typeof(step->'atGain') IS DISTINCT FROM 'number' OR jsonb_typeof(step->'sellFraction') IS DISTINCT FROM 'number'
    ) THEN
      result := result || jsonb_build_object('take_profit_ladder', COALESCE((SELECT jsonb_agg(jsonb_build_object('atGain', step->'atGain', 'sellFraction', step->'sellFraction')) FROM jsonb_array_elements(value->'take_profit_ladder') step), '[]'::jsonb));
    ELSE result := result || '{"ladder_omitted":true}'::jsonb; END IF;
  END IF;
  RETURN result;
END;
$$;
CREATE FUNCTION audit_actor() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN current_setting('memebots.actor', true) IN ('owner', 'system') OR current_setting('memebots.actor', true) ~ '^bot:[a-f0-9-]{36}$'
 THEN current_setting('memebots.actor', true) ELSE 'system/database' END
$$;
CREATE FUNCTION audit_policy_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_policy jsonb; after_policy jsonb; changed boolean;
BEGIN
  after_policy := audit_safe_policy(TG_TABLE_NAME, to_jsonb(NEW));
  IF TG_OP = 'UPDATE' THEN before_policy := audit_safe_policy(TG_TABLE_NAME, to_jsonb(OLD)); END IF;
  changed := TG_OP = 'INSERT' OR before_policy IS DISTINCT FROM after_policy;
  IF TG_TABLE_NAME = 'bots' AND TG_OP = 'UPDATE' THEN
    changed := changed OR NEW.strategy_params IS DISTINCT FROM OLD.strategy_params;
    IF NEW.strategy_params IS DISTINCT FROM OLD.strategy_params THEN
      after_policy := after_policy || '{"strategy_params_changed":true}'::jsonb;
    END IF;
  END IF;
  -- Even excluded fields changing must leave a safe trace, without copying their content.
  IF TG_TABLE_NAME = 'risk_profiles' AND TG_OP = 'UPDATE' THEN
    changed := changed OR NEW.take_profit_ladder IS DISTINCT FROM OLD.take_profit_ladder;
  END IF;
  IF changed THEN
    INSERT INTO audit_log(actor, action, entity_type, entity_id, details)
    VALUES(audit_actor(), CASE WHEN TG_OP = 'INSERT' THEN 'config.created' ELSE 'config.changed' END,
      TG_TABLE_NAME, NEW.id::text, jsonb_build_object('before', before_policy, 'after', after_policy, 'source', 'database_trigger'));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bots_audit AFTER INSERT OR UPDATE ON bots FOR EACH ROW EXECUTE FUNCTION audit_policy_mutation();
CREATE TRIGGER wallets_audit AFTER INSERT OR UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION audit_policy_mutation();
CREATE TRIGGER risk_profiles_audit AFTER INSERT OR UPDATE ON risk_profiles FOR EACH ROW EXECUTE FUNCTION audit_policy_mutation();
CREATE FUNCTION audit_order_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reason_category text := 'unspecified'; payload jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.bot_id, NEW.position_id, NEW.token_mint, NEW.side, NEW.mode, NEW.status, NEW.amount_in_raw, NEW.max_slippage_bps, NEW.veto_reason)
    IS NOT DISTINCT FROM ROW(OLD.bot_id, OLD.position_id, OLD.token_mint, OLD.side, OLD.mode, OLD.status, OLD.amount_in_raw, OLD.max_slippage_bps, OLD.veto_reason) THEN RETURN NEW; END IF;
  IF NEW.veto_reason IN ('risk_limit', 'safety', 'balance', 'slippage', 'kill_switch', 'stale_data', 'policy') THEN reason_category := NEW.veto_reason; END IF;
  payload := jsonb_build_object('bot_id', NEW.bot_id, 'mode', NEW.mode, 'side', NEW.side, 'status', NEW.status,
    'amount_in_raw', NEW.amount_in_raw::text, 'max_slippage_bps', NEW.max_slippage_bps, 'reason_category', reason_category, 'source', 'database_trigger');
  IF TG_OP = 'UPDATE' THEN payload := payload || jsonb_build_object('previous_status', OLD.status); END IF;
  INSERT INTO audit_log(actor, action, entity_type, entity_id, details)
    VALUES(audit_actor(), CASE WHEN NEW.status = 'vetoed' THEN 'order.vetoed' WHEN TG_OP = 'INSERT' THEN 'order.created' ELSE 'order.updated' END, 'orders', NEW.id::text, payload);
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_audit AFTER INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION audit_order_mutation();
