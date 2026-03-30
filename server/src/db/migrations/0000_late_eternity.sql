CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE TABLE "action_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"action_type" varchar(50) NOT NULL,
	"action_id" varchar(100) NOT NULL,
	"request_hash" varchar(128) NOT NULL,
	"response" jsonb NOT NULL,
	"status_code" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"created_by" uuid,
	"type" varchar(20) NOT NULL,
	"geometry" geometry(Geometry,4326) NOT NULL,
	"label" varchar(255),
	"style" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" varchar(20) DEFAULT 'all' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenge_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"status" varchar(20) NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"submission" jsonb,
	"location_at_claim" geometry(Point,4326),
	"warning_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"zone_id" uuid,
	"title" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"kind" varchar(50) NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completion_mode" varchar(20) DEFAULT 'self_report' NOT NULL,
	"scoring" jsonb DEFAULT '{"points":10}'::jsonb NOT NULL,
	"difficulty" varchar(10),
	"status" varchar(20) DEFAULT 'available' NOT NULL,
	"current_claim_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"state_version" bigint NOT NULL,
	"event_type" varchar(50) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" uuid NOT NULL,
	"actor_type" varchar(20) NOT NULL,
	"actor_id" uuid,
	"actor_team_id" uuid,
	"before_state" jsonb,
	"after_state" jsonb,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"mode_key" varchar(50) NOT NULL,
	"city" varchar(255),
	"center_lat" numeric(10, 7) NOT NULL,
	"center_lng" numeric(10, 7) NOT NULL,
	"default_zoom" integer NOT NULL,
	"boundary" geometry(Polygon,4326),
	"status" varchar(20) DEFAULT 'setup' NOT NULL,
	"state_version" bigint DEFAULT 0 NOT NULL,
	"win_condition" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_location_samples" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"location" geometry(Point,4326) NOT NULL,
	"gps_error_meters" real,
	"speed_mps" real,
	"heading_degrees" real,
	"source" varchar(20) DEFAULT 'browser' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"team_id" uuid,
	"display_name" varchar(100) NOT NULL,
	"session_token" varchar(255) NOT NULL,
	"push_subscription" jsonb,
	"last_lat" numeric(10, 7),
	"last_lng" numeric(10, 7),
	"last_gps_error" real,
	"last_seen_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"player_id" uuid,
	"resource_type" varchar(50) NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"sequence" bigint NOT NULL,
	"reason" varchar(100) NOT NULL,
	"reference_id" uuid,
	"reference_type" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"color" varchar(7) NOT NULL,
	"icon" varchar(50),
	"join_code" varchar(8) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"geometry" geometry(Polygon,4326) NOT NULL,
	"centroid" geometry(Point,4326),
	"owner_team_id" uuid,
	"captured_at" timestamp with time zone,
	"point_value" integer DEFAULT 1 NOT NULL,
	"claim_radius_meters" integer,
	"max_gps_error_meters" integer,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_receipts" ADD CONSTRAINT "action_receipts_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_receipts" ADD CONSTRAINT "action_receipts_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_created_by_players_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_claims" ADD CONSTRAINT "challenge_claims_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_claims" ADD CONSTRAINT "challenge_claims_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_claims" ADD CONSTRAINT "challenge_claims_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_claims" ADD CONSTRAINT "challenge_claims_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_current_claim_id_challenge_claims_id_fk" FOREIGN KEY ("current_claim_id") REFERENCES "public"."challenge_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_location_samples" ADD CONSTRAINT "player_location_samples_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_location_samples" ADD CONSTRAINT "player_location_samples_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_ledger" ADD CONSTRAINT "resource_ledger_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_ledger" ADD CONSTRAINT "resource_ledger_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_ledger" ADD CONSTRAINT "resource_ledger_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_owner_team_id_teams_id_fk" FOREIGN KEY ("owner_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_receipts_player_action_unique" ON "action_receipts" USING btree ("player_id","action_type","action_id");--> statement-breakpoint
CREATE INDEX "idx_receipts_lookup" ON "action_receipts" USING btree ("player_id","action_type","action_id");--> statement-breakpoint
CREATE INDEX "idx_annotations_game" ON "annotations" USING btree ("game_id","visibility");--> statement-breakpoint
CREATE INDEX "idx_claims_challenge" ON "challenge_claims" USING btree ("challenge_id","status");--> statement-breakpoint
CREATE INDEX "idx_claims_team" ON "challenge_claims" USING btree ("team_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_one_active_claim_per_challenge" ON "challenge_claims" USING btree ("challenge_id") WHERE "challenge_claims"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_challenges_game_status" ON "challenges" USING btree ("game_id","status");--> statement-breakpoint
CREATE INDEX "idx_challenges_zone" ON "challenges" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "idx_events_version" ON "game_events" USING btree ("game_id","state_version");--> statement-breakpoint
CREATE INDEX "idx_events_type" ON "game_events" USING btree ("game_id","event_type","created_at");--> statement-breakpoint
CREATE INDEX "idx_location_samples_geo" ON "player_location_samples" USING gist ("location");--> statement-breakpoint
CREATE INDEX "idx_location_cleanup" ON "player_location_samples" USING btree ("game_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "players_session_token_unique" ON "players" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX "idx_players_session" ON "players" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX "idx_players_game_team" ON "players" USING btree ("game_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_resource_sequence_team" ON "resource_ledger" USING btree ("game_id","team_id","resource_type","sequence") WHERE "resource_ledger"."player_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_resource_sequence_player" ON "resource_ledger" USING btree ("game_id","team_id","player_id","resource_type","sequence") WHERE "resource_ledger"."player_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_resource_balance" ON "resource_ledger" USING btree ("game_id","team_id","resource_type","sequence" desc) WHERE "resource_ledger"."player_id" is null;--> statement-breakpoint
CREATE INDEX "idx_resource_player_balance" ON "resource_ledger" USING btree ("game_id","player_id","resource_type","sequence" desc) WHERE "resource_ledger"."player_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "teams_game_join_code_idx" ON "teams" USING btree ("game_id","join_code");--> statement-breakpoint
CREATE INDEX "idx_zones_geometry" ON "zones" USING gist ("geometry");--> statement-breakpoint
CREATE INDEX "idx_zones_game" ON "zones" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "idx_zones_game_owner" ON "zones" USING btree ("game_id","owner_team_id");