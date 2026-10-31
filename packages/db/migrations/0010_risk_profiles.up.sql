-- BOT-10: policy only. These profiles do not enable trading or enforce runtime risk.
ALTER TABLE risk_profiles
  ADD COLUMN safety_mode text NOT NULL DEFAULT 'standard'
    CHECK (safety_mode IN ('strict', 'standard', 'relaxed')),
  ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE FUNCTION risk_profile_ladder_valid(ladder jsonb, trail numeric)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE step jsonb; gain numeric; sale numeric; previous numeric := 0; total numeric := 0;
BEGIN
  IF jsonb_typeof(ladder) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(ladder) NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  FOR step IN SELECT * FROM jsonb_array_elements(ladder) LOOP
    IF jsonb_typeof(step) <> 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(step)) <> 2
       OR jsonb_typeof(step->'atGain') IS DISTINCT FROM 'number'
       OR jsonb_typeof(step->'sellFraction') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    gain := (step->>'atGain')::numeric;
    sale := (step->>'sellFraction')::numeric;
    -- Ladder numbers cross a JSON/JavaScript boundary; reject underflow/overflow there.
    IF gain <= previous OR gain < 5e-324 OR gain > 1.7976931348623157e308
       OR sale < 5e-324 OR sale > 1 THEN RETURN false; END IF;
    previous := gain;
    total := total + sale;
  END LOOP;
  RETURN total <= 1 AND (total = 1 OR trail IS NOT NULL);
END;
$$;

ALTER TABLE risk_profiles
  ADD CONSTRAINT risk_profiles_ladder_integrity CHECK (risk_profile_ladder_valid(take_profit_ladder, trailing_stop_fraction)),
  ADD CONSTRAINT risk_profiles_finite_decimals CHECK (
    position_fraction < 'Infinity'::numeric AND stop_loss_fraction < 'Infinity'::numeric
    AND min_reward_risk < 'Infinity'::numeric AND daily_loss_limit_fraction < 'Infinity'::numeric
    AND min_liquidity_usd < 'Infinity'::numeric
    AND (trailing_stop_fraction IS NULL OR trailing_stop_fraction < 'Infinity'::numeric)),
  ADD CONSTRAINT risk_profiles_display_name CHECK (length(trim(display_name)) BETWEEN 1 AND 100);

CREATE FUNCTION advance_risk_profile_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.revision := OLD.revision + 1; RETURN NEW; END;
$$;
CREATE TRIGGER risk_profiles_revision BEFORE UPDATE ON risk_profiles
  FOR EACH ROW EXECUTE FUNCTION advance_risk_profile_revision();

-- First nine policy values and safety modes are literal specification values.
-- Slippage/liquidity/score/hold/streak are documented paper engineering defaults.
-- ON CONFLICT preserves existing owner policy, including on down/up.
INSERT INTO risk_profiles (id, display_name, position_fraction, stop_loss_fraction,
  take_profit_ladder, trailing_stop_fraction, min_reward_risk, max_open_positions,
  daily_loss_limit_fraction, safety_mode, max_slippage_bps, min_liquidity_usd,
  min_safety_score, max_hold_minutes, losing_streak_limit)
VALUES
 ('conservative', 'Conservative', .01, .10, '[{"atGain":0.15,"sellFraction":0.5}]', .08, 1.5, 3, .03, 'strict', 100, 100000, 85, 240, 3),
 ('balanced', 'Balanced', .02, .20, '[{"atGain":0.3,"sellFraction":0.4},{"atGain":0.6,"sellFraction":0.3}]', .15, 2, 5, .06, 'standard', 200, 50000, 75, 360, 4),
 ('aggressive', 'Aggressive', .04, .35, '[{"atGain":1,"sellFraction":0.3},{"atGain":2,"sellFraction":0.3}]', .25, 3, 8, .12, 'standard', 300, 25000, 65, 240, 5),
 ('degen', 'Degen', .05, .50, '[{"atGain":1,"sellFraction":0.25},{"atGain":4,"sellFraction":0.25}]', .40, 5, 10, .20, 'relaxed', 500, 10000, 55, 120, 5)
ON CONFLICT (id) DO NOTHING;
