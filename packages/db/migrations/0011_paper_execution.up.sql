-- BOT-11: immutable approved intent, random draws, quote and result. No signing material.
CREATE TABLE paper_execution_intents (
 order_id uuid PRIMARY KEY REFERENCES orders(id),
 intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE paper_execution_positions (
 order_id uuid PRIMARY KEY REFERENCES paper_execution_intents(order_id),
 position_id uuid NOT NULL REFERENCES positions(id)
);
CREATE TABLE paper_execution_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES paper_execution_intents(order_id),
 idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 160),
 sequence integer NOT NULL CHECK (sequence > 0),
 input_raw numeric(39,0) NOT NULL CHECK (input_raw > 0),
 seed text NOT NULL CHECK (seed ~ '^[a-f0-9]{64}$'),
 model jsonb NOT NULL CHECK (jsonb_typeof(model) = 'object'),
 draws jsonb NOT NULL CHECK (jsonb_typeof(draws) = 'object'),
 started_at_ms bigint NOT NULL,
 ready_at_ms bigint NOT NULL CHECK (ready_at_ms >= started_at_ms),
 UNIQUE (order_id, sequence)
);
CREATE TABLE paper_execution_quote_claims (
 attempt_id uuid PRIMARY KEY REFERENCES paper_execution_attempts(id),
 claimed_at_ms bigint NOT NULL
);
CREATE TABLE paper_execution_quotes (
 attempt_id uuid PRIMARY KEY REFERENCES paper_execution_attempts(id),
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE paper_execution_results (
 attempt_id uuid PRIMARY KEY REFERENCES paper_execution_attempts(id),
 order_id uuid NOT NULL REFERENCES orders(id),
 result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
 fill_id uuid UNIQUE REFERENCES fills(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['paper_execution_intents','paper_execution_positions','paper_execution_attempts','paper_execution_quote_claims','paper_execution_quotes','paper_execution_results'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_change()',t || '_append_only',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_change()',t || '_no_truncate',t);
 END LOOP;
END $$;
-- Durable shared quote/RPC request budget survives broker restarts.
CREATE TABLE paper_execution_requests (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX paper_execution_requests_at ON paper_execution_requests(requested_at);
ALTER TABLE orders DROP CONSTRAINT orders_max_slippage_bps_check;
ALTER TABLE orders ADD CONSTRAINT orders_max_slippage_bps_check CHECK (max_slippage_bps >= 0);
