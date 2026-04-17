import { and, asc, eq, or } from 'drizzle-orm';
import type {
  Annotation,
  Challenge,
  ChallengeClaim,
  GameStateSnapshot,
  JsonObject,
  Player,
  Team,
} from '@city-game/shared';
import { errorCodes } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { annotations, challengeClaims, challenges, players, teams } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { ModeRegistry } from '../modes/index.js';
import { getAllBalances } from './resource-service.js';
import { getGameById, serializeGameRecord } from './game-service.js';
import { listZonesByGame } from './spatial-service.js';
import { listTeamLocationsByGame, shouldBroadcastTeamLocations } from './team-location-service.js';

interface ViewerContextInput {
  gameId: string;
  playerId: string;
}

export async function buildGameStateSnapshot(
  db: DatabaseClient,
  registry: ModeRegistry,
  input: ViewerContextInput,
): Promise<GameStateSnapshot> {
  const game = await getGameById(db, input.gameId);
  const teamLocationsEnabled = shouldBroadcastTeamLocations(game.settings);
  const [teamRows, playerRows, zoneRows, challengeRows, claimRows, annotationRows, teamResources, teamLocations] = await Promise.all([
    db.select().from(teams).where(eq(teams.gameId, input.gameId)).orderBy(asc(teams.createdAt)),
    db.select().from(players).where(eq(players.gameId, input.gameId)).orderBy(asc(players.createdAt)),
    listZonesByGame(db, input.gameId),
    db.select()
      .from(challenges)
      .where(and(eq(challenges.gameId, input.gameId), or(eq(challenges.isDeckActive, true), eq(challenges.status, 'claimed'), eq(challenges.status, 'completed'))))
      .orderBy(asc(challenges.sortOrder), asc(challenges.createdAt)),
    db.select().from(challengeClaims).where(eq(challengeClaims.gameId, input.gameId)).orderBy(asc(challengeClaims.createdAt)),
    db.select().from(annotations).where(eq(annotations.gameId, input.gameId)).orderBy(asc(annotations.createdAt)),
    getAllBalances(db, input.gameId),
    teamLocationsEnabled ? listTeamLocationsByGame(db, input.gameId) : Promise.resolve([]),
  ]);

  const viewerPlayerRow = playerRows.find((player) => player.id == input.playerId);

  if (!viewerPlayerRow) {
    throw new AppError(errorCodes.unauthorized, {
      message: 'Player cannot access another game.',
    });
  }

  const serializedTeams = teamRows.map((team) => serializeTeamRow(team));
  const serializedPlayers = playerRows.map((player) => serializePlayerRow(player));
  const viewerPlayer = serializedPlayers.find((player) => player.id == input.playerId) ?? serializePlayerRow(viewerPlayerRow);
  const viewerTeam = viewerPlayer.teamId ? serializedTeams.find((team) => team.id == viewerPlayer.teamId) ?? null : null;
  const filteredAnnotations = filterAnnotationsForViewer(annotationRows, playerRows, viewerPlayer.teamId).map((annotation) =>
    serializeAnnotationRow(annotation),
  );

  const fullSnapshot = {
    game: serializeGameRecord(game),
    player: viewerPlayer,
    team: viewerTeam,
    teams: serializedTeams,
    players: serializedPlayers,
    teamLocations,
    zones: zoneRows,
    challenges: challengeRows.map((challenge) => serializeChallengeRow(challenge)),
    claims: claimRows.map((claim) => serializeClaimRow(claim)),
    annotations: filteredAnnotations,
    teamResources,
  } satisfies GameStateSnapshot;

  return registry.get(game.modeKey).filterStateForViewer(fullSnapshot, {
    playerId: viewerPlayer.id,
    teamId: viewerPlayer.teamId,
  });
}

export function filterAnnotationsForViewer(
  rows: Array<typeof annotations.$inferSelect>,
  playerRows: Array<typeof players.$inferSelect>,
  viewerTeamId: string | null,
) {
  const teamIdByPlayerId = new Map(playerRows.map((player) => [player.id, player.teamId]));

  return rows.filter((annotation) => {
    if (annotation.visibility === 'all') {
      return true;
    }

    if (!viewerTeamId || !annotation.createdBy) {
      return false;
    }

    return teamIdByPlayerId.get(annotation.createdBy) === viewerTeamId;
  });
}

function serializeTeamRow(row: typeof teams.$inferSelect): Team {
  return {
    id: row.id,
    gameId: row.gameId,
    name: row.name,
    color: row.color as Team['color'],
    icon: row.icon,
    joinCode: row.joinCode,
    metadata: row.metadata as Team['metadata'],
    createdAt: row.createdAt.toISOString(),
  };
}

function serializePlayerRow(row: typeof players.$inferSelect): Player {
  return {
    id: row.id,
    gameId: row.gameId,
    teamId: row.teamId,
    displayName: row.displayName,
    pushSubscription: row.pushSubscription as Player['pushSubscription'],
    lastLat: null,
    lastLng: null,
    lastGpsError: null,
    lastSeenAt: null,
    metadata: row.metadata as Player['metadata'],
    createdAt: row.createdAt.toISOString(),
  } as Player;
}

function serializeChallengeRow(row: typeof challenges.$inferSelect): Challenge {
  return {
    id: row.id,
    gameId: row.gameId,
    zoneId: row.zoneId,
    title: row.title,
    description: row.description,
    kind: row.kind as Challenge['kind'],
    config: row.config as Challenge['config'],
    completionMode: row.completionMode,
    scoring: row.scoring as Challenge['scoring'],
    difficulty: row.difficulty as Challenge['difficulty'],
    sortOrder: row.sortOrder,
    isDeckActive: row.isDeckActive,
    status: row.status as Challenge['status'],
    currentClaimId: row.currentClaimId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeClaimRow(row: typeof challengeClaims.$inferSelect): ChallengeClaim {
  return {
    id: row.id,
    challengeId: row.challengeId,
    gameId: row.gameId,
    teamId: row.teamId,
    playerId: row.playerId,
    status: row.status as ChallengeClaim['status'],
    claimedAt: row.claimedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    submission: row.submission as ChallengeClaim['submission'],
    locationAtClaim: row.locationAtClaim as ChallengeClaim['locationAtClaim'],
    warningSent: row.warningSent,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeAnnotationRow(row: typeof annotations.$inferSelect): Annotation {
  return {
    id: row.id,
    gameId: row.gameId,
    createdBy: row.createdBy,
    type: row.type as Annotation['type'],
    geometry: row.geometry as unknown as Annotation['geometry'],
    label: row.label,
    style: row.style as JsonObject,
    visibility: row.visibility as Annotation['visibility'],
    createdAt: row.createdAt.toISOString(),
  };
}
