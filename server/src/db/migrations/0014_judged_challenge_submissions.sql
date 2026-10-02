-- Judged challenges: every team may submit once; judges score submissions after the game.
ALTER TABLE "challenge_claims" ADD COLUMN IF NOT EXISTS "judged_points" integer;--> statement-breakpoint
ALTER TABLE "challenge_claims" ADD COLUMN IF NOT EXISTS "judged_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_one_judged_submission_per_team" ON "challenge_claims" USING btree ("challenge_id","team_id") WHERE "challenge_claims"."status" = 'submitted';
