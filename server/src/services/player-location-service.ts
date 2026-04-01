import { and, eq, lt, sql } from 'drizzle-orm';
import type { GpsPayload, GameSettings } from '@city-game/shared';
import { errorCodes } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { games, playerLocationSamples, players } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

const DEFAULT_LOCATION_RETENTION_HOURS = 24;
const DEFAULT_LOCATION_SOURCE = 'browser';
const MS_PER_HOUR = 60 * 60 * 1_000;

export interface LocationTrackingSettings {
  enabled: boolean;
  retentionHours: number;
}

export interface UpdatePlayerLocationInput {
  playerId: string;
  gpsPayload: GpsPayload;
}

export interface UpdatePlayerLocationResult {
  player: typeof players.$inferSelect;
  tracking: LocationTrackingSettings;
  sampleStored: boolean;
}

export interface CleanupPlayerLocationSamplesResult {
  deletedSamples: number;
}

export async function updatePlayerLocation(
  db: DatabaseClient,
  input: UpdatePlayerLocationInput,
): Promise<UpdatePlayerLocationResult> {
  const [existingPlayer] = await db
    .select({ id: players.id, gameId: players.gameId })
    .from(players)
    .where(eq(players.id, input.playerId))
    .limit(1);

  if (!existingPlayer) {
    throw new AppError(errorCodes.unauthorized);
  }

  const [game] = await db.select({ settings: games.settings }).from(games).where(eq(games.id, existingPlayer.gameId)).limit(1);

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }

  const tracking = getLocationTrackingSettings(game.settings);
  const recordedAt = new Date(input.gpsPayload.capturedAt);

  const [player] = await db
    .update(players)
    .set({
      lastLat: input.gpsPayload.lat.toString(),
      lastLng: input.gpsPayload.lng.toString(),
      lastGpsError: input.gpsPayload.gpsErrorMeters,
      lastSeenAt: recordedAt,
    })
    .where(eq(players.id, input.playerId))
    .returning();

  let sampleStored = false;

  if (tracking.enabled) {
    await db.insert(playerLocationSamples).values({
      gameId: player.gameId,
      playerId: player.id,
      recordedAt,
      location: sql`ST_SetSRID(ST_MakePoint(${input.gpsPayload.lng}, ${input.gpsPayload.lat}), 4326)`,
      gpsErrorMeters: input.gpsPayload.gpsErrorMeters,
      speedMps: input.gpsPayload.speedMps,
      headingDegrees: input.gpsPayload.headingDegrees,
      source: DEFAULT_LOCATION_SOURCE,
    });
    sampleStored = true;
  }

  return {
    player,
    tracking,
    sampleStored,
  };
}

export async function cleanupPlayerLocationSamples(
  db: DatabaseClient,
  now: Date = new Date(),
): Promise<CleanupPlayerLocationSamplesResult> {
  const gameRows = await db.select({ id: games.id, settings: games.settings }).from(games);
  let deletedSamples = 0;

  for (const game of gameRows) {
    const tracking = getLocationTrackingSettings(game.settings);
    const cutoff = new Date(now.getTime() - tracking.retentionHours * MS_PER_HOUR);
    const deletedRows = await db
      .delete(playerLocationSamples)
      .where(and(eq(playerLocationSamples.gameId, game.id), lt(playerLocationSamples.recordedAt, cutoff)))
      .returning({ id: playerLocationSamples.id });

    deletedSamples += deletedRows.length;
  }

  return {
    deletedSamples,
  };
}

export function getLocationTrackingSettings(settings: unknown): LocationTrackingSettings {
  const gameSettings = normalizeGameSettings(settings);
  const retentionHours = getRetentionHours(gameSettings.location_retention_hours);

  return {
    enabled: gameSettings.location_tracking_enabled === true,
    retentionHours,
  };
}

function normalizeGameSettings(settings: unknown): GameSettings {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return {};
  }

  return settings as GameSettings;
}

function getRetentionHours(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_LOCATION_RETENTION_HOURS;
  }

  return value;
}
