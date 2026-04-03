CREATE TABLE "challenge_set_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"map_zone_id" uuid,
	"title" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"kind" varchar(50) NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completion_mode" varchar(20) DEFAULT 'self_report' NOT NULL,
	"scoring" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"difficulty" varchar(10),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenge_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "challenge_set_id" uuid;--> statement-breakpoint
ALTER TABLE "challenge_set_items" ADD CONSTRAINT "challenge_set_items_set_id_challenge_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."challenge_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_set_items" ADD CONSTRAINT "challenge_set_items_map_zone_id_map_zones_id_fk" FOREIGN KEY ("map_zone_id") REFERENCES "public"."map_zones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_challenge_set_items_set" ON "challenge_set_items" USING btree ("set_id","sort_order","created_at");--> statement-breakpoint
CREATE INDEX "idx_challenge_set_items_map_zone" ON "challenge_set_items" USING btree ("map_zone_id");--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_challenge_set_id_challenge_sets_id_fk" FOREIGN KEY ("challenge_set_id") REFERENCES "public"."challenge_sets"("id") ON DELETE set null ON UPDATE no action;