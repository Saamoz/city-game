import { eq, sql } from 'drizzle-orm';
import {
  eventTypes,
  errorCodes,
  type EventActorType,
  type Game,
  type GameModeKey,
  type GameStatus,
  type JsonObject,
  type WinCondition,
} from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { gameEvents, games } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { ModeRegistry } from '../modes/index.js';
import { cloneChallengeSetToGame } from './challenge-set-service.js';
import { cloneMapZonesToGame } from './map-service.js';

export type GameRecord = typeof games.$inferSelect;
export type LifecycleTransition = 'start' | 'pause' | 'resume' | 'end';

interface TransitionResult {
  game: GameRecord;
  stateVersion: number;
}

interface TransitionOptions {
  actorType?: EventActorType;
  actorId?: string | null;
  actorTeamId?: string | null;
  eventMeta?: JsonObject;
  timestamp?: Date;
}

export interface WinConditionEndInput {
  winnerTeamId?: string | null;
  reason: string;
  winCondition?: WinCondition | null;
  now?: Date;
}

export async function incrementVersion(db: DatabaseClient, gameId: string): Promise<number> {
  const [game] = await db
    .update(games)
    .set({
      stateVersion: sql`${games.stateVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(games.id, gameId))
    .returning({ stateVersion: games.stateVersion });

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }

  return game.stateVersion;
}

export async function getGameById(db: DatabaseClient, gameId: string): Promise<GameRecord> {
  const [game] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }

  return game;
}

export async function lockGameById(db: DatabaseClient, gameId: string): Promise<GameRecord> {
  const [game] = await db.select().from(games).where(eq(games.id, gameId)).limit(1).for('update');

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }

  return game;
}

export async function transitionGameLifecycle(
  db: DatabaseClient,
  registry: ModeRegistry,
  gameId: string,
  transition: LifecycleTransition,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as DatabaseClient;
    const currentGame = await lockGameById(transactionalDb, gameId);

    return applyLifecycleTransition(transactionalDb, registry, currentGame, transition, {
      actorType: options.actorType ?? 'admin',
      actorId: options.actorId ?? null,
      actorTeamId: options.actorTeamId ?? null,
      eventMeta: {
        transition,
        ...(options.eventMeta ?? {}),
      },
      timestamp: options.timestamp,
    });
  });
}

export async function endGameForWinCondition(
  db: DatabaseClient,
  registry: ModeRegistry,
  game: GameRecord,
  input: WinConditionEndInput,
): Promise<TransitionResult> {
  return applyLifecycleTransition(db, registry, game, 'end', {
    actorType: 'system',
    eventMeta: {
      trigger: 'win_condition',
      reason: input.reason,
      winnerTeamId: input.winnerTeamId ?? null,
      winCondition: input.winCondition ?? null,
    },
    timestamp: input.now,
  });
}

export function serializeGameRecord(game: GameRecord): Game {
  return {
    id: game.id,
    mapId: game.mapId,
    challengeSetId: game.challengeSetId,
    name: game.name,
    modeKey: game.modeKey as GameModeKey,
    city: game.city,
    centerLat: Number(game.centerLat),
    centerLng: Number(game.centerLng),
    defaultZoom: game.defaultZoom,
    boundary: game.boundary as Game['boundary'],
    status: game.status as GameStatus,
    stateVersion: game.stateVersion,
    winCondition: game.winCondition as Game['winCondition'],
    settings: game.settings as Game['settings'],
    startedAt: game.startedAt?.toISOString() ?? null,
    endedAt: game.endedAt?.toISOString() ?? null,
    createdAt: game.createdAt.toISOString(),
    updatedAt: game.updatedAt.toISOString(),
  };
}

async function applyLifecycleTransition(
  db: DatabaseClient,
  registry: ModeRegistry,
  currentGame: GameRecord,
  transition: LifecycleTransition,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  assertValidTransition(currentGame, transition);

  const modeHandler = registry.get(currentGame.modeKey);
  const nextTimestamp = options.timestamp ?? new Date();
  const lifecycleUpdate = buildLifecycleUpdate(currentGame, transition, nextTimestamp);

  let runtimeGame = currentGame;

  const [updatedGame] = await db
    .update(games)
    .set({
      ...lifecycleUpdate,
      updatedAt: nextTimestamp,
    })
    .where(eq(games.id, currentGame.id))
    .returning();

  runtimeGame = updatedGame;

  if (transition === 'start') {

    if (runtimeGame.mapId) {
      await cloneMapZonesToGame(db, runtimeGame.mapId, runtimeGame.id);
    }

    if (runtimeGame.challengeSetId) {
      const activeChallengeCount = getActiveChallengeCount(runtimeGame.settings as JsonObject);
      const challengeTotalCount = await cloneChallengeSetToGame(db, runtimeGame.challengeSetId, runtimeGame.id, activeChallengeCount);
      const nextSettings = normalizeRuntimeSettings(runtimeGame.settings as JsonObject, {
        activeChallengeCount,
        challengeTotalCount,
      });

      const [nextGame] = await db
        .update(games)
        .set({
          settings: nextSettings,
          updatedAt: nextTimestamp,
        })
        .where(eq(games.id, runtimeGame.id))
        .returning();

      runtimeGame = nextGame;
    }

    await modeHandler.onGameStart({ db, game: runtimeGame });
  }

  if (transition === 'end') {
    await modeHandler.onGameEnd({ db, game: updatedGame });
  }

  const stateVersion = await incrementVersion(db, currentGame.id);
  const gameForEvent = {
    ...runtimeGame,
    stateVersion,
  } satisfies GameRecord;

  await db.insert(gameEvents).values({
    gameId: currentGame.id,
    stateVersion,
    eventType: getLifecycleEventType(transition),
    entityType: 'game',
    entityId: currentGame.id,
    actorType: options.actorType ?? 'admin',
    actorId: options.actorId ?? null,
    actorTeamId: options.actorTeamId ?? null,
    beforeState: serializeLifecycleState(currentGame),
    afterState: serializeLifecycleState(gameForEvent),
    meta: {
      transition,
      ...(options.eventMeta ?? {}),
      game: serializeGameRecord(gameForEvent),
    },
  });

  return {
    game: gameForEvent,
    stateVersion,
  };
}


function getActiveChallengeCount(settings: JsonObject): number {
  const value = settings.active_challenge_count;
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 3;
}

function normalizeRuntimeSettings(
  settings: JsonObject,
  input: { activeChallengeCount: number; challengeTotalCount: number },
): JsonObject {
  return {
    ...settings,
    active_challenge_count: input.activeChallengeCount,
    challenge_total_count: input.challengeTotalCount,
  };
}
function assertValidTransition(game: GameRecord, transition: LifecycleTransition): void {
  const validCurrentStatuses = getValidCurrentStatuses(transition);

  if (validCurrentStatuses.includes(game.status as GameStatus)) {
    return;
  }

  throw new AppError(errorCodes.invalidGameStateTransition, {
    message: `Cannot ${transition} a game from status ${game.status}.`,
    details: {
      transition,
      currentStatus: game.status,
      validStatuses: validCurrentStatuses,
    },
  });
}

function getValidCurrentStatuses(transition: LifecycleTransition): readonly GameStatus[] {
  switch (transition) {
    case 'start':
      return ['setup'];
    case 'pause':
      return ['active'];
    case 'resume':
      return ['paused'];
    case 'end':
      return ['active', 'paused'];
  }
}

function buildLifecycleUpdate(game: GameRecord, transition: LifecycleTransition, timestamp: Date) {
  switch (transition) {
    case 'start':
      return {
        status: 'active' as const,
        startedAt: game.startedAt ?? timestamp,
        endedAt: null,
      };
    case 'pause':
      return {
        status: 'paused' as const,
      };
    case 'resume':
      return {
        status: 'active' as const,
      };
    case 'end':
      return {
        status: 'completed' as const,
        endedAt: timestamp,
      };
  }
}

function getLifecycleEventType(transition: LifecycleTransition) {
  switch (transition) {
    case 'start':
      return eventTypes.gameStarted;
    case 'pause':
      return eventTypes.gamePaused;
    case 'resume':
      return eventTypes.gameResumed;
    case 'end':
      return eventTypes.gameEnded;
  }
}

function serializeLifecycleState(game: GameRecord) {
  return {
    status: game.status,
    stateVersion: game.stateVersion,
    startedAt: game.startedAt?.toISOString() ?? null,
    endedAt: game.endedAt?.toISOString() ?? null,
  };
}
