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
import { getChallengeRerollState } from '../modes/territory/reroll-service.js';

interface ViewerContextInput {
  gameId: string;
  playerId: string;
}

export interface LoadedGameState {
  modeKey: string;
  shared: Omit<GameStateSnapshot, 'player' | 'team' | 'annotations'>;
  playerRows: Array<typeof players.$inferSelect>;
  annotationRows: Array<typeof annotations.$inferSelect>;
}

export async function buildGameStateSnapshot(
  db: DatabaseClient,
  registry: ModeRegistry,
  input: ViewerContextInput,
): Promise<GameStateSnapshot> {
  const state = await loadGameState(db, input.gameId);
  return buildViewerSnapshot(registry, state, input.playerId);
}

// Loads everything a snapshot needs once, so a broadcast to many viewers can reuse it via buildViewerSnapshot.
export async function loadGameState(db: DatabaseClient, gameId: string): Promise<LoadedGameState> {
  const game = await getGameById(db, gameId);
  const teamLocationsEnabled = shouldBroadcastTeamLocations(game.settings);
  const [teamRows, playerRows, zoneRows, challengeRows, claimRows, annotationRows, teamResources, teamLocations, challengeReroll] = await Promise.all([
    db.select().from(teams).where(eq(teams.gameId, gameId)).orderBy(asc(teams.createdAt)),
    db.select().from(players).where(eq(players.gameId, gameId)).orderBy(asc(players.createdAt)),
    listZonesByGame(db, gameId),
    db.select()
      .from(challenges)
      .where(and(eq(challenges.gameId, gameId), or(eq(challenges.isDeckActive, true), eq(challenges.status, 'claimed'), eq(challenges.status, 'completed'), eq(challenges.status, 'skipped'))))
      .orderBy(asc(challenges.sortOrder), asc(challenges.createdAt)),
    db.select().from(challengeClaims).where(eq(challengeClaims.gameId, gameId)).orderBy(asc(challengeClaims.createdAt)),
    db.select().from(annotations).where(eq(annotations.gameId, gameId)).orderBy(asc(annotations.createdAt)),
    getAllBalances(db, gameId),
    teamLocationsEnabled ? listTeamLocationsByGame(db, gameId) : Promise.resolve([]),
    getChallengeRerollState(db, gameId),
  ]);

  return {
    modeKey: game.modeKey,
    shared: {
      game: serializeGameRecord(game),
      teams: teamRows.map((team) => serializeTeamRow(team)),
      players: playerRows.map((player) => serializePlayerRow(player)),
      teamLocations,
      zones: zoneRows,
      challenges: challengeRows.map((challenge) => serializeChallengeRow(challenge)),
      claims: claimRows.map((claim) => serializeClaimRow(claim)),
      teamResources,
      challengeReroll,
    },
    playerRows,
    annotationRows,
  };
}

export function hasViewer(state: LoadedGameState, playerId: string): boolean {
  return state.playerRows.some((player) => player.id === playerId);
}

export function buildViewerSnapshot(
  registry: ModeRegistry,
  state: LoadedGameState,
  playerId: string,
): GameStateSnapshot {
  const viewerPlayer = state.shared.players.find((player) => player.id === playerId);

  if (!viewerPlayer) {
    throw new AppError(errorCodes.unauthorized, {
      message: 'Player cannot access another game.',
    });
  }

  const viewerTeam = viewerPlayer.teamId ? state.shared.teams.find((team) => team.id === viewerPlayer.teamId) ?? null : null;
  const filteredAnnotations = filterAnnotationsForViewer(state.annotationRows, state.playerRows, viewerPlayer.teamId).map((annotation) =>
    serializeAnnotationRow(annotation),
  );

  const fullSnapshot = {
    ...state.shared,
    player: viewerPlayer,
    team: viewerTeam,
    annotations: filteredAnnotations,
  } satisfies GameStateSnapshot;

  return registry.get(state.modeKey).filterStateForViewer(fullSnapshot, {
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
    // Judging notes are for judges only.
    submission: row.status === 'submitted' ? null : row.submission as ChallengeClaim['submission'],
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
