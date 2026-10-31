-- Reverses 0001_initial_schema. Drops every table: run only on a database you mean to empty.
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS fills;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS positions;
DROP TABLE IF EXISTS tokens;
DROP TABLE IF EXISTS bots;
DROP TABLE IF EXISTS wallets;
DROP TABLE IF EXISTS risk_profiles;
DROP FUNCTION IF EXISTS touch_updated_at();
DROP FUNCTION IF EXISTS reject_change();
