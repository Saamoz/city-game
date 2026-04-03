CREATE TABLE "map_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"geometry" geometry(Geometry,4326) NOT NULL,
	"centroid" geometry(Point,4326),
	"point_value" integer DEFAULT 1 NOT NULL,
	"claim_radius_meters" integer,
	"max_gps_error_meters" integer,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"city" varchar(255),
	"center_lat" numeric(10, 7) NOT NULL,
	"center_lng" numeric(10, 7) NOT NULL,
	"default_zoom" integer NOT NULL,
	"boundary" geometry(Polygon,4326),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "map_id" uuid;--> statement-breakpoint
ALTER TABLE "map_zones" ADD CONSTRAINT "map_zones_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_map_zones_geometry" ON "map_zones" USING gist ("geometry");--> statement-breakpoint
CREATE INDEX "idx_map_zones_map" ON "map_zones" USING btree ("map_id");--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id") ON DELETE no action ON UPDATE no action;