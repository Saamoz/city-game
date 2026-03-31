import { eq, sql } from 'drizzle-orm';
import { eventTypes, errorCodes, type Game, type GameModeKey, type GameStatus } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { gameEvents, games } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { ModeRegistry } from '../modes/index.js';

export type GameRecord = typeof games.$inferSelect;
export type LifecycleTransition = 'start' | 'pause' | 'resume' | 'end';

interface TransitionResult {
  game: GameRecord;
  stateVersion: number;
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

export async function transitionGameLifecycle(
  db: DatabaseClient,
  registry: ModeRegistry,
  gameId: string,
  transition: LifecycleTransition,
): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as DatabaseClient;
    const currentGame = await getGameById(transactionalDb, gameId);
    assertValidTransition(currentGame, transition);

    const modeHandler = registry.get(currentGame.modeKey);
    const nextTimestamp = new Date();
    const lifecycleUpdate = buildLifecycleUpdate(currentGame, transition, nextTimestamp);

    const [updatedGame] = await transactionalDb
      .update(games)
      .set({
        ...lifecycleUpdate,
        updatedAt: nextTimestamp,
      })
      .where(eq(games.id, gameId))
      .returning();

    if (transition === 'start') {
      await modeHandler.onGameStart({ db: transactionalDb, game: updatedGame });
    }

    if (transition === 'end') {
      await modeHandler.onGameEnd({ db: transactionalDb, game: updatedGame });
    }

    const stateVersion = await incrementVersion(transactionalDb, gameId);
    const gameForEvent = {
      ...updatedGame,
      stateVersion,
    } satisfies GameRecord;

    await transactionalDb.insert(gameEvents).values({
      gameId,
      stateVersion,
      eventType: getLifecycleEventType(transition),
      entityType: 'game',
      entityId: gameId,
      actorType: 'admin',
      actorId: null,
      actorTeamId: null,
      beforeState: serializeLifecycleState(currentGame),
      afterState: serializeLifecycleState(gameForEvent),
      meta: {
        transition,
        game: serializeGameRecord(gameForEvent),
      },
    });

    return {
      game: gameForEvent,
      stateVersion,
    };
  });
}

export function serializeGameRecord(game: GameRecord): Game {
  return {
    id: game.id,
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
