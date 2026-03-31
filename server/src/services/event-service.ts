import { and, asc, desc, eq, gt } from 'drizzle-orm';
import {
  MAX_DELTA_SYNC_GAP,
  errorCodes,
  type EventActorType,
  type EventEntityType,
  type GameEventPayload,
  type GameEventRecord,
  type GameEventType,
  type JsonObject,
  type JsonValue,
} from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { gameEvents, games } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { incrementVersion } from './game-service.js';

interface GameEventRow {
  id: string;
  gameId: string;
  stateVersion: number;
  eventType: GameEventType;
  entityType: EventEntityType;
  entityId: string;
  actorType: EventActorType;
  actorId: string | null;
  actorTeamId: string | null;
  beforeState: JsonValue | null;
  afterState: JsonValue | null;
  meta: JsonObject;
  createdAt: Date;
}

export interface LogEventInput<TEvent extends GameEventType = GameEventType> {
  gameId: string;
  eventType: TEvent;
  entityType: EventEntityType;
  entityId: string;
  actorType: EventActorType;
  actorId?: string | null;
  actorTeamId?: string | null;
  beforeState?: JsonValue | null;
  afterState?: JsonValue | null;
  meta?: JsonObject;
  payload?: GameEventPayload<TEvent>;
}

export interface AppendEventInput<TEvent extends GameEventType = GameEventType> {
  eventType: TEvent;
  entityType: EventEntityType;
  entityId: string;
  actorType: EventActorType;
  actorId?: string | null;
  actorTeamId?: string | null;
  beforeState?: JsonValue | null;
  afterState?: JsonValue | null;
  meta?: JsonObject;
  payload?: GameEventPayload<TEvent>;
}

export interface AppendEventsInput {
  gameId: string;
  events: AppendEventInput[];
}

export interface AppendEventsResult {
  stateVersion: number;
  events: GameEventRecord[];
}

export interface GetRecentEventsInput {
  gameId: string;
  limit?: number;
  eventType?: GameEventType;
}

export interface GetEventsSinceInput {
  gameId: string;
  sinceVersion: number;
  limit?: number;
}

export interface EventsSinceResult {
  events: GameEventRecord[];
  stateVersion: number;
  fullSyncRequired: boolean;
}

export async function logEvent<TEvent extends GameEventType>(
  db: DatabaseClient,
  input: LogEventInput<TEvent>,
): Promise<GameEventRecord> {
  return db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as DatabaseClient;
    const result = await appendEvents(transactionalDb, {
      gameId: input.gameId,
      events: [
        {
          eventType: input.eventType,
          entityType: input.entityType,
          entityId: input.entityId,
          actorType: input.actorType,
          actorId: input.actorId ?? null,
          actorTeamId: input.actorTeamId ?? null,
          beforeState: input.beforeState ?? null,
          afterState: input.afterState ?? null,
          meta: input.meta,
          payload: input.payload,
        },
      ],
    });

    return result.events[0];
  });
}

export async function appendEvents(db: DatabaseClient, input: AppendEventsInput): Promise<AppendEventsResult> {
  if (input.events.length === 0) {
    throw new Error('appendEvents requires at least one event.');
  }

  const stateVersion = await incrementVersion(db, input.gameId);
  const rows = await db
    .insert(gameEvents)
    .values(
      input.events.map((event) => ({
        gameId: input.gameId,
        stateVersion,
        eventType: event.eventType,
        entityType: event.entityType,
        entityId: event.entityId,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        actorTeamId: event.actorTeamId ?? null,
        beforeState: event.beforeState ?? null,
        afterState: event.afterState ?? null,
        meta: event.meta ?? (event.payload as JsonObject | undefined) ?? {},
      })),
    )
    .returning();

  return {
    stateVersion,
    events: rows.map((row) => serializeGameEvent(row as GameEventRow)),
  };
}

export async function getRecentEvents(db: DatabaseClient, input: GetRecentEventsInput): Promise<GameEventRecord[]> {
  await assertGameExists(db, input.gameId);

  const rows = await db
    .select()
    .from(gameEvents)
    .where(
      and(
        eq(gameEvents.gameId, input.gameId),
        input.eventType ? eq(gameEvents.eventType, input.eventType) : undefined,
      ),
    )
    .orderBy(desc(gameEvents.stateVersion), desc(gameEvents.createdAt))
    .limit(input.limit ?? 50);

  return rows.map((row) => serializeGameEvent(row as GameEventRow));
}

export async function getEventsSince(db: DatabaseClient, input: GetEventsSinceInput): Promise<EventsSinceResult> {
  const [game] = await db
    .select({ stateVersion: games.stateVersion })
    .from(games)
    .where(eq(games.id, input.gameId))
    .limit(1);

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }

  const versionGap = game.stateVersion - input.sinceVersion;
  if (versionGap > MAX_DELTA_SYNC_GAP) {
    return {
      events: [],
      stateVersion: game.stateVersion,
      fullSyncRequired: true,
    };
  }

  const rows = await db
    .select()
    .from(gameEvents)
    .where(and(eq(gameEvents.gameId, input.gameId), gt(gameEvents.stateVersion, input.sinceVersion)))
    .orderBy(asc(gameEvents.stateVersion), asc(gameEvents.createdAt))
    .limit(input.limit ?? MAX_DELTA_SYNC_GAP);

  return {
    events: rows.map((row) => serializeGameEvent(row as GameEventRow)),
    stateVersion: game.stateVersion,
    fullSyncRequired: false,
  };
}

async function assertGameExists(db: DatabaseClient, gameId: string) {
  const [game] = await db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).limit(1);

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }
}

function serializeGameEvent(row: GameEventRow): GameEventRecord {
  return {
    id: row.id,
    gameId: row.gameId,
    stateVersion: row.stateVersion,
    eventType: row.eventType,
    entityType: row.entityType,
    entityId: row.entityId,
    actorType: row.actorType,
    actorId: row.actorId,
    actorTeamId: row.actorTeamId,
    beforeState: row.beforeState,
    afterState: row.afterState,
    meta: row.meta,
    createdAt: row.createdAt.toISOString(),
  };
}
