ALTER TABLE "challenges" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "is_deck_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_challenges_game_active" ON "challenges" USING btree ("game_id","is_deck_active","sort_order");