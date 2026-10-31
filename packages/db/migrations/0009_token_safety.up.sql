-- Evidence is cached, never a reusable permissive policy decision.
CREATE TABLE token_safety_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key text NOT NULL CHECK (length(cache_key) BETWEEN 40 AND 110),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  mint text NOT NULL CHECK (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  refresh_started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  CHECK (expires_at > refresh_started_at)
);
CREATE INDEX token_safety_history ON token_safety_snapshots (cache_key, created_at DESC);
CREATE TABLE token_safety_cache (
  cache_key text PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES token_safety_snapshots(id),
  refresh_started_at timestamptz NOT NULL,
  refresh_after timestamptz NOT NULL
);
CREATE TABLE token_safety_leases (
  cache_key text PRIMARY KEY,
  lease_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  lease_until timestamptz NOT NULL
);
CREATE TABLE token_safety_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key text NOT NULL,
  snapshot_id uuid REFERENCES token_safety_snapshots(id),
  policy_version text NOT NULL,
  policy_fingerprint text NOT NULL CHECK (policy_fingerprint ~ '^[a-f0-9]{64}$'),
  policy jsonb NOT NULL,
  decision jsonb NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX token_safety_evaluations_key ON token_safety_evaluations (cache_key, evaluated_at DESC);
CREATE TRIGGER token_safety_snapshots_append_only BEFORE UPDATE OR DELETE ON token_safety_snapshots FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER token_safety_snapshots_no_truncate BEFORE TRUNCATE ON token_safety_snapshots FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE TRIGGER token_safety_evaluations_append_only BEFORE UPDATE OR DELETE ON token_safety_evaluations FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER token_safety_evaluations_no_truncate BEFORE TRUNCATE ON token_safety_evaluations FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
