-- Preserve all profile rows and owner edits; bots may reference them.
DROP TRIGGER risk_profiles_revision ON risk_profiles;
DROP FUNCTION advance_risk_profile_revision();
ALTER TABLE risk_profiles
  DROP CONSTRAINT risk_profiles_ladder_integrity,
  DROP CONSTRAINT risk_profiles_finite_decimals,
  DROP CONSTRAINT risk_profiles_display_name,
  DROP COLUMN safety_mode,
  DROP COLUMN revision;
DROP FUNCTION risk_profile_ladder_valid(jsonb, numeric);
