-- Reverses 0016_kill_switch.
DROP TRIGGER risk_streaks_breaker ON risk_streaks;
DROP FUNCTION losing_streak_breaker();
DROP FUNCTION operator_alert(text, text, boolean, text);
DROP TRIGGER paper_attempts_buy_gate ON paper_execution_attempts;
DROP FUNCTION buy_attempt_gate();
DROP TRIGGER orders_buy_gate ON orders;
DROP FUNCTION buy_order_gate();
DROP FUNCTION buy_block_reason(uuid);
ALTER TABLE bots DROP CONSTRAINT pause_is_complete, DROP COLUMN pause_reason, DROP COLUMN paused_at;
DROP TABLE kill_switch;
DROP FUNCTION kill_switch_audit();
DROP FUNCTION kill_switch_touch();
-- monitoring_events is append-only, so kill-switch and losing-streak alerts recorded
-- while 0016 was applied stay in history. The original checks come back NOT VALID:
-- they bind every new row again without rejecting that history.
ALTER TABLE monitoring_events DROP CONSTRAINT monitoring_events_code_check;
ALTER TABLE monitoring_events ADD CONSTRAINT monitoring_events_code_check CHECK (code IN
  ('heartbeat_stale', 'http', 'rpc', 'malformed', 'timeout', 'transport', 'unavailable')) NOT VALID;
ALTER TABLE monitoring_incidents DROP CONSTRAINT monitoring_incidents_code_check;
ALTER TABLE monitoring_incidents ADD CONSTRAINT monitoring_incidents_code_check CHECK (code IN
  ('heartbeat_stale', 'http', 'rpc', 'malformed', 'timeout', 'transport', 'unavailable')) NOT VALID;
ALTER TABLE monitoring_incidents DROP CONSTRAINT monitoring_incidents_category_check;
ALTER TABLE monitoring_incidents ADD CONSTRAINT monitoring_incidents_category_check CHECK (category IN
  ('bot_stalled', 'rpc_unhealthy', 'discovery_unhealthy')) NOT VALID;
