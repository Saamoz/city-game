CREATE TABLE "challenge_reroll_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"challenge_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "reroll_available" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "reroll_completion_progress" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "challenge_reroll_votes" ADD CONSTRAINT "challenge_reroll_votes_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_reroll_votes" ADD CONSTRAINT "challenge_reroll_votes_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_reroll_votes" ADD CONSTRAINT "challenge_reroll_votes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "challenge_reroll_votes_challenge_team_unique" ON "challenge_reroll_votes" USING btree ("challenge_id","team_id");--> statement-breakpoint
CREATE INDEX "idx_challenge_reroll_votes_game" ON "challenge_reroll_votes" USING btree ("game_id");