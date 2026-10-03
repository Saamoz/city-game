-- The judge's decision on a judged submission (pass/fail, winner, or explicit points plus approved bonuses).
-- judged_points stays the computed award; this keeps what the judge chose so the UI can show it.
ALTER TABLE "challenge_claims" ADD COLUMN IF NOT EXISTS "judged_decision" jsonb;
