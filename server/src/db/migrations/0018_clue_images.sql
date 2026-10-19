-- The final clue: candidate pictures cut into fragments, the fragment each challenge hands out,
-- and when the admin showed every team's fragments to everyone.
CREATE TABLE IF NOT EXISTS "clue_images" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "game_id" uuid NOT NULL REFERENCES "games"("id") ON DELETE CASCADE,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "fragment_count" integer NOT NULL,
  "thumbnail" text NOT NULL,
  "is_selected" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_clue_images_game" ON "clue_images" USING btree ("game_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_one_selected_clue_image_per_game" ON "clue_images" USING btree ("game_id") WHERE "is_selected";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clue_image_tiles" (
  "image_id" uuid NOT NULL REFERENCES "clue_images"("id") ON DELETE CASCADE,
  "tile_index" integer NOT NULL,
  "content_type" varchar(50) NOT NULL,
  "data" text NOT NULL,
  PRIMARY KEY ("image_id", "tile_index")
);
--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN IF NOT EXISTS "clue_fragment_index" integer;
--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN IF NOT EXISTS "clue_revealed_at" timestamp with time zone;
