ALTER TABLE "player_location_samples" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "player_location_samples" ADD COLUMN "sample_bucket" bigint;--> statement-breakpoint
ALTER TABLE "player_location_samples" ADD CONSTRAINT "player_location_samples_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_location_team_path" ON "player_location_samples" USING btree ("game_id","team_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_location_team_bucket_unique" ON "player_location_samples" USING btree ("game_id","team_id","sample_bucket");