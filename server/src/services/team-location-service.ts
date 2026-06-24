import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { GameSettings, TeamLocation } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { players, teams } from '../db/schema.js';

export interface TeamLocationRepresentative {
  id: string;
  teamId: string;
  lastLat: string;
  lastLng: string;
  lastGpsError: number | null;
  lastSeenAt: Date;
}

export async function getTeamLocationRepresentative(
  db: DatabaseClient,
  gameId: string,
  teamId: string,
): Promise<TeamLocationRepresentative | null> {
  const [player] = await db
    .select({
      id: players.id,
      teamId: players.teamId,
      lastLat: players.lastLat,
      lastLng: players.lastLng,
      lastGpsError: players.lastGpsError,
      lastSeenAt: players.lastSeenAt,
    })
    .from(players)
    .where(and(
      eq(players.gameId, gameId),
      eq(players.teamId, teamId),
      isNotNull(players.lastLat),
      isNotNull(players.lastLng),
      isNotNull(players.lastSeenAt),
    ))
    .orderBy(desc(players.lastSeenAt), desc(players.id))
    .limit(1);

  if (!player || !player.teamId || !player.lastLat || !player.lastLng || !player.lastSeenAt) {
    return null;
  }

  return player as TeamLocationRepresentative;
}

export async function listTeamLocationsByGame(
  db: DatabaseClient,
  gameId: string,
): Promise<TeamLocation[]> {
  const [teamRows, playerRows] = await Promise.all([
    db.select({ id: teams.id }).from(teams).where(eq(teams.gameId, gameId)),
    db
      .select({
        id: players.id,
        teamId: players.teamId,
        lastLat: players.lastLat,
        lastLng: players.lastLng,
        lastGpsError: players.lastGpsError,
        lastSeenAt: players.lastSeenAt,
      })
      .from(players)
      .where(
        and(
          eq(players.gameId, gameId),
          isNotNull(players.teamId),
          isNotNull(players.lastLat),
          isNotNull(players.lastLng),
          isNotNull(players.lastSeenAt),
        ),
      ),
  ]);

  const newestByTeamId = new Map<string, (typeof playerRows)[number]>();
  for (const row of playerRows) {
    if (!row.teamId || !row.lastSeenAt || row.lastLat === null || row.lastLng === null) {
      continue;
    }

    const existing = newestByTeamId.get(row.teamId);
    const rowTime = row.lastSeenAt.getTime();
    const existingTime = existing?.lastSeenAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (!existing || rowTime > existingTime || (rowTime === existingTime && row.id > existing.id)) {
      newestByTeamId.set(row.teamId, row);
    }
  }

  return teamRows
    .map((team) => {
      const row = newestByTeamId.get(team.id);
      if (!row || !row.lastSeenAt || row.lastLat === null || row.lastLng === null) {
        return null;
      }

      return {
        teamId: team.id,
        lat: Number(row.lastLat),
        lng: Number(row.lastLng),
        gpsErrorMeters: row.lastGpsError,
        updatedAt: row.lastSeenAt.toISOString(),
      } satisfies TeamLocation;
    })
    .filter((value): value is TeamLocation => value !== null);
}

export function shouldBroadcastTeamLocations(settings: unknown): boolean {
  const gameSettings = normalizeGameSettings(settings);
  return gameSettings.broadcast_team_locations !== false;
}

function normalizeGameSettings(settings: unknown): GameSettings {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return {};
  }

  return settings as GameSettings;
}
