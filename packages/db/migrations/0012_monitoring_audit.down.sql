DROP TRIGGER orders_audit ON orders;
DROP TRIGGER bots_audit ON bots;
DROP TRIGGER wallets_audit ON wallets;
DROP TRIGGER risk_profiles_audit ON risk_profiles;
DROP TRIGGER bots_monitoring ON bots;
DROP FUNCTION audit_order_mutation();
DROP FUNCTION audit_policy_mutation();
DROP FUNCTION audit_actor();
DROP FUNCTION audit_safe_policy(text, jsonb);
DROP FUNCTION monitoring_bot_expectation();
DROP FUNCTION monitoring_poll();
DROP FUNCTION monitoring_scan();
DROP FUNCTION monitoring_transition(text, text, boolean, text);
DROP TABLE monitoring_health, monitoring_deliveries, monitoring_events, monitoring_incidents, runtime_config_snapshots, bot_heartbeats;
-- Existing audit_log and its immutable history are deliberately preserved.
