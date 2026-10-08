-- Challenge sets belong to the city they were written for. Null means a generic set for any map.
ALTER TABLE "challenge_sets" ADD COLUMN IF NOT EXISTS "map_id" uuid REFERENCES "maps"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_challenge_sets_map_id" ON "challenge_sets" USING btree ("map_id");
--> statement-breakpoint
-- Existing sets take the map their pinned, area or zone challenges were placed on.
UPDATE "challenge_sets" AS set_row
SET "map_id" = placed.map_id
FROM (
  SELECT DISTINCT ON (item."set_id") item."set_id", COALESCE(zone."map_id", existing_map."id") AS map_id
  FROM "challenge_set_items" AS item
  LEFT JOIN "map_zones" AS zone ON zone."id" = item."map_zone_id"
  LEFT JOIN "maps" AS existing_map ON existing_map."id"::text = item."metadata"->>'sourceMapId'
  WHERE COALESCE(zone."map_id", existing_map."id") IS NOT NULL
  ORDER BY item."set_id", item."sort_order", item."created_at"
) AS placed
WHERE set_row."id" = placed."set_id" AND set_row."map_id" IS NULL;
