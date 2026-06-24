import { eq, sql } from 'drizzle-orm';
import type { GpsPayload } from '@city-game/shared';
import { errorCodes } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { games, playerLocationSamples, players } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { getTeamLocationRepresentative } from './team-location-service.js';

const DEFAULT_LOCATION_SOURCE = 'browser';
const TEAM_LOCATION_SAMPLE_INTERVAL_MS = 15_000;

export interface LocationTrackingSettings {
  enabled: boolean;
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

export async function updatePlayerLocation(
  db: DatabaseClient,
  input: UpdatePlayerLocationInput,
): Promise<UpdatePlayerLocationResult> {
  const [existingPlayer] = await db
    .select({ id: players.id, gameId: players.gameId, teamId: players.teamId })
    .from(players)
    .where(eq(players.id, input.playerId))
    .limit(1);

  if (!existingPlayer) {
    throw new AppError(errorCodes.unauthorized);
  }

  const [game] = await db
    .select({ status: games.status })
    .from(games)
    .where(eq(games.id, existingPlayer.gameId))
    .limit(1);

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }

  const tracking = {
    enabled: game.status === 'active' && existingPlayer.teamId !== null,
  };
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

  if (tracking.enabled && player.teamId) {
    const representative = await getTeamLocationRepresentative(db, player.gameId, player.teamId);
    if (representative?.id === player.id) {
      const insertedSamples = await db
        .insert(playerLocationSamples)
        .values({
          gameId: player.gameId,
          teamId: player.teamId,
          playerId: player.id,
          sampleBucket: Math.floor(recordedAt.getTime() / TEAM_LOCATION_SAMPLE_INTERVAL_MS),
          recordedAt,
          location: sql`ST_SetSRID(ST_MakePoint(${input.gpsPayload.lng}, ${input.gpsPayload.lat}), 4326)`,
          gpsErrorMeters: input.gpsPayload.gpsErrorMeters,
          speedMps: input.gpsPayload.speedMps,
          headingDegrees: input.gpsPayload.headingDegrees,
          source: DEFAULT_LOCATION_SOURCE,
        })
        .onConflictDoNothing()
        .returning({ id: playerLocationSamples.id });
      sampleStored = insertedSamples.length > 0;
    }
  }

  return {
    player,
    tracking,
    sampleStored,
  };
}
