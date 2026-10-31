DROP TABLE paper_execution_requests;
DROP TABLE paper_execution_results;
DROP TABLE paper_execution_quotes;
DROP TABLE paper_execution_quote_claims;
DROP TABLE paper_execution_attempts;
DROP TABLE paper_execution_positions;
DROP TABLE paper_execution_intents;
-- Refuses rollback while a zero-slippage order exists rather than mutating its approved intent.
ALTER TABLE orders DROP CONSTRAINT orders_max_slippage_bps_check;
ALTER TABLE orders ADD CONSTRAINT orders_max_slippage_bps_check CHECK (max_slippage_bps > 0);
