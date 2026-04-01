import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { geometryGeneric4326, geometryPoint4326, geometryPolygon4326 } from './geometry.js';

const defaultJsonObject = sql`'{}'::jsonb`;
const defaultJsonArray = sql`'[]'::jsonb`;
const defaultChallengeScoring = sql`'{"points":10}'::jsonb`;

export const games = pgTable(
  'games',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    modeKey: varchar('mode_key', { length: 50 }).notNull(),
    city: varchar('city', { length: 255 }),
    centerLat: decimal('center_lat', { precision: 10, scale: 7 }).notNull(),
    centerLng: decimal('center_lng', { precision: 10, scale: 7 }).notNull(),
    defaultZoom: integer('default_zoom').notNull(),
    boundary: geometryPolygon4326('boundary'),
    status: varchar('status', { length: 20 }).notNull().default('setup'),
    stateVersion: bigint('state_version', { mode: 'number' }).notNull().default(0),
    winCondition: jsonb('win_condition').notNull().default(defaultJsonArray),
    settings: jsonb('settings').notNull().default(defaultJsonObject),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    gameId: uuid('game_id').notNull().references(() => games.id),
    name: varchar('name', { length: 255 }).notNull(),
    color: varchar('color', { length: 7 }).notNull(),
    icon: varchar('icon', { length: 50 }),
    joinCode: varchar('join_code', { length: 8 }).notNull(),
    metadata: jsonb('metadata').notNull().default(defaultJsonObject),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    joinCodeUnique: uniqueIndex('teams_game_join_code_idx').on(table.gameId, table.joinCode),
  }),
);

export const players = pgTable(
  'players',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    gameId: uuid('game_id').notNull().references(() => games.id),
    teamId: uuid('team_id').references(() => teams.id),
    displayName: varchar('display_name', { length: 100 }).notNull(),
    sessionToken: varchar('session_token', { length: 255 }).notNull(),
    pushSubscription: jsonb('push_subscription'),
    lastLat: decimal('last_lat', { precision: 10, scale: 7 }),
    lastLng: decimal('last_lng', { precision: 10, scale: 7 }),
    lastGpsError: real('last_gps_error'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default(defaultJsonObject),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionTokenUnique: uniqueIndex('players_session_token_unique').on(table.sessionToken),
    playersSessionIdx: index('idx_players_session').on(table.sessionToken),
    playersGameTeamIdx: index('idx_players_game_team').on(table.gameId, table.teamId),
  }),
);

export const zones = pgTable(
  'zones',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    gameId: uuid('game_id').notNull().references(() => games.id),
    name: varchar('name', { length: 255 }).notNull(),
    geometry: geometryGeneric4326('geometry').notNull(),
    centroid: geometryPoint4326('centroid'),
    ownerTeamId: uuid('owner_team_id').references(() => teams.id),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    pointValue: integer('point_value').notNull().default(1),
    claimRadiusMeters: integer('claim_radius_meters'),
    maxGpsErrorMeters: integer('max_gps_error_meters'),
    isDisabled: boolean('is_disabled').notNull().default(false),
    metadata: jsonb('metadata').notNull().default(defaultJsonObject),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    zonesGeometryIdx: index('idx_zones_geometry').using('gist', table.geometry),
    zonesGameIdx: index('idx_zones_game').on(table.gameId),
    zonesGameOwnerIdx: index('idx_zones_game_owner').on(table.gameId, table.ownerTeamId),
  }),
);

export const challenges = pgTable(
  'challenges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    gameId: uuid('game_id').notNull().references(() => games.id),
    zoneId: uuid('zone_id').references(() => zones.id),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description').notNull(),
    kind: varchar('kind', { length: 50 }).notNull(),
    config: jsonb('config').notNull().default(defaultJsonObject),
    completionMode: varchar('completion_mode', { length: 20 }).notNull().default('self_report'),
    scoring: jsonb('scoring').notNull().default(defaultChallengeScoring),
    difficulty: varchar('difficulty', { length: 10 }),
    status: varchar('status', { length: 20 }).notNull().default('available'),
    currentClaimId: uuid('current_claim_id').references((): AnyPgColumn => challengeClaims.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    challengesGameStatusIdx: index('idx_challenges_game_status').on(table.gameId, table.status),
    challengesZoneIdx: index('idx_challenges_zone').on(table.zoneId),
  }),
);

export const challengeClaims = pgTable(
  'challenge_claims',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    challengeId: uuid('challenge_id').notNull().references(() => challenges.id),
    gameId: uuid('game_id').notNull().references(() => games.id),
    teamId: uuid('team_id').notNull().references(() => teams.id),
    playerId: uuid('player_id').notNull().references(() => players.id),
    status: varchar('status', { length: 20 }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    submission: jsonb('submission'),
    locationAtClaim: geometryPoint4326('location_at_claim'),
    warningSent: boolean('warning_sent').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    claimsChallengeIdx: index('idx_claims_challenge').on(table.challengeId, table.status),
    claimsTeamIdx: index('idx_claims_team').on(table.teamId, table.status),
    oneActiveClaimPerChallenge: uniqueIndex('idx_one_active_claim_per_challenge')
      .on(table.challengeId)
      .where(sql`${table.status} = 'active'`),
  }),
);

export const resourceLedger = pgTable(
  'resource_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    gameId: uuid('game_id').notNull().references(() => games.id),
    teamId: uuid('team_id').notNull().references(() => teams.id),
    playerId: uuid('player_id').references(() => players.id),
    resourceType: varchar('resource_type', { length: 50 }).notNull(),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    reason: varchar('reason', { length: 100 }).notNull(),
    referenceId: uuid('reference_id'),
    referenceType: varchar('reference_type', { length: 50 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    resourceSequenceTeamUnique: uniqueIndex('idx_resource_sequence_team')
      .on(table.gameId, table.teamId, table.resourceType, table.sequence)
      .where(sql`${table.playerId} is null`),
    resourceSequencePlayerUnique: uniqueIndex('idx_resource_sequence_player')
      .on(table.gameId, table.teamId, table.playerId, table.resourceType, table.sequence)
      .where(sql`${table.playerId} is not null`),
    resourceBalanceIdx: index('idx_resource_balance')
      .on(table.gameId, table.teamId, table.resourceType, desc(table.sequence))
      .where(sql`${table.playerId} is null`),
    resourcePlayerBalanceIdx: index('idx_resource_player_balance')
      .on(table.gameId, table.playerId, table.resourceType, desc(table.sequence))
      .where(sql`${table.playerId} is not null`),
  }),
);

export const gameEvents = pgTable(
  'game_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    gameId: uuid('game_id').notNull().references(() => games.id),
    stateVersion: bigint('state_version', { mode: 'number' }).notNull(),
    eventType: varchar('event_type', { length: 50 }).notNull(),
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    actorType: varchar('actor_type', { length: 20 }).notNull(),
    actorId: uuid('actor_id'),
    actorTeamId: uuid('actor_team_id'),
    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state'),
    meta: jsonb('meta').notNull().default(defaultJsonObject),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    eventsVersionIdx: index('idx_events_version').on(table.gameId, table.stateVersion),
    eventsTypeIdx: index('idx_events_type').on(table.gameId, table.eventType, table.createdAt),
  }),
);

export const actionReceipts = pgTable(
  'action_receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    gameId: uuid('game_id').notNull().references(() => games.id),
    playerId: uuid('player_id').references(() => players.id),
    scopeKey: varchar('scope_key', { length: 150 }).notNull(),
    actionType: varchar('action_type', { length: 50 }).notNull(),
    actionId: varchar('action_id', { length: 100 }).notNull(),
    requestHash: varchar('request_hash', { length: 128 }).notNull(),
    response: jsonb('response').notNull(),
    responseHeaders: jsonb('response_headers').notNull().default(defaultJsonObject),
    statusCode: integer('status_code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    actionReceiptsUnique: uniqueIndex('action_receipts_scope_action_unique').on(
      table.scopeKey,
      table.actionType,
      table.actionId,
    ),
    actionReceiptsLookupIdx: index('idx_receipts_lookup').on(table.scopeKey, table.actionType, table.actionId),
  }),
);

export const annotations = pgTable(
  'annotations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    gameId: uuid('game_id').notNull().references(() => games.id),
    createdBy: uuid('created_by').references(() => players.id),
    type: varchar('type', { length: 20 }).notNull(),
    geometry: geometryGeneric4326('geometry').notNull(),
    label: varchar('label', { length: 255 }),
    style: jsonb('style').notNull().default(defaultJsonObject),
    visibility: varchar('visibility', { length: 20 }).notNull().default('all'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    annotationsGameIdx: index('idx_annotations_game').on(table.gameId, table.visibility),
  }),
);

export const playerLocationSamples = pgTable(
  'player_location_samples',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    gameId: uuid('game_id').notNull().references(() => games.id),
    playerId: uuid('player_id').notNull().references(() => players.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    location: geometryPoint4326('location').notNull(),
    gpsErrorMeters: real('gps_error_meters'),
    speedMps: real('speed_mps'),
    headingDegrees: real('heading_degrees'),
    source: varchar('source', { length: 20 }).notNull().default('browser'),
  },
  (table) => ({
    locationSamplesGeoIdx: index('idx_location_samples_geo').using('gist', table.location),
    locationCleanupIdx: index('idx_location_cleanup').on(table.gameId, table.recordedAt),
  }),
);

export const schema = {
  games,
  teams,
  players,
  zones,
  challenges,
  challengeClaims,
  resourceLedger,
  gameEvents,
  actionReceipts,
  annotations,
  playerLocationSamples,
};
