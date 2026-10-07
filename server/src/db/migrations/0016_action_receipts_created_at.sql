-- Lets the receipt pruning job delete expired idempotency receipts without scanning the table.
CREATE INDEX IF NOT EXISTS "idx_receipts_created_at" ON "action_receipts" USING btree ("created_at");
