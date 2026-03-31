DROP INDEX "action_receipts_player_action_unique";--> statement-breakpoint
DROP INDEX "idx_receipts_lookup";--> statement-breakpoint
ALTER TABLE "action_receipts" ALTER COLUMN "player_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "action_receipts" ADD COLUMN "scope_key" varchar(150);--> statement-breakpoint
UPDATE "action_receipts"
SET "scope_key" = COALESCE('player:' || "player_id"::text, 'public')
WHERE "scope_key" IS NULL;--> statement-breakpoint
ALTER TABLE "action_receipts" ALTER COLUMN "scope_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "action_receipts" ADD COLUMN "response_headers" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "action_receipts_scope_action_unique" ON "action_receipts" USING btree ("scope_key","action_type","action_id");--> statement-breakpoint
CREATE INDEX "idx_receipts_lookup" ON "action_receipts" USING btree ("scope_key","action_type","action_id");
