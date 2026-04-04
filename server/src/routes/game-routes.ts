import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { GAME_MODE_KEYS, STATE_VERSION_HEADER, errorCodes, socketServerEventTypes } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { games, teams } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { generateJoinCode } from '../lib/join-code.js';
import { executeIdempotentMutation } from '../services/idempotency-service.js';
import {
  getGameById,
  serializeGameRecord,
  transitionGameLifecycle,
  type LifecycleTransition,
} from '../services/game-service.js';
import { getChallengeSetByIdOrThrow } from '../services/challenge-set-service.js';
import { applyMapDefaultsToGame } from '../services/map-service.js';

const winConditionItemSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['type'],
  properties: {
    type: {
      type: 'string',
      enum: ['all_zones', 'zone_majority', 'time_limit', 'score_threshold'],
    },
    threshold: { type: 'number' },
    duration_minutes: { type: 'integer', minimum: 1 },
    target: { type: 'integer', minimum: 1 },
  },
} as const;

const gameCreateBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'modeKey'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    modeKey: { type: 'string', enum: [...GAME_MODE_KEYS] },
    city: { type: 'string', minLength: 1, maxLength: 255 },
    mapId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    challengeSetId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    centerLat: { type: 'number' },
    centerLng: { type: 'number' },
    defaultZoom: { type: 'integer' },
    winCondition: {
      type: 'array',
      items: winConditionItemSchema,
    },
    settings: {
      type: 'object',
      additionalProperties: true,
    },
  },
} as const;

const gameUpdateBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    city: { type: 'string', minLength: 1, maxLength: 255 },
    mapId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    challengeSetId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    centerLat: { type: 'number' },
    centerLng: { type: 'number' },
    defaultZoom: { type: 'integer' },
    winCondition: {
      type: 'array',
      items: winConditionItemSchema,
    },
    settings: {
      type: 'object',
      additionalProperties: true,
    },
  },
} as const;

const teamCreateBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'color'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
    icon: { type: 'string', minLength: 1, maxLength: 50 },
    metadata: {
      type: 'object',
      additionalProperties: true,
    },
  },
} as const;

const teamUpdateBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
    icon: { anyOf: [{ type: 'string', minLength: 1, maxLength: 50 }, { type: 'null' }] },
    metadata: {
      type: 'object',
      additionalProperties: true,
    },
  },
} as const;

const paramsWithGameIdSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export const gameRoutes: FastifyPluginAsync = async (app) => {
  app.get('/games', async (_request, reply) => {
    const rows = await app.db.select().from(games).orderBy(desc(games.createdAt));
    reply.send({ games: rows.map(serializeGameRecord) });
  });

  app.get('/game/active', async (_request, reply) => {
    const [game] = await app.db
      .select()
      .from(games)
      .where(ne(games.status, 'completed'))
      .orderBy(desc(games.createdAt))
      .limit(1);

    if (!game) {
      throw new AppError(errorCodes.gameNotFound, {
        message: 'No active game found.',
      });
    }

    reply.send({ game: serializeGameRecord(game) });
  });

  app.post(
    '/game',
    {
      preHandler: [app.requireAdmin],
      schema: {
        body: gameCreateBodySchema,
      },
    },
    async (request, reply) => {
      await executeIdempotentMutation(app, request, reply, async (db) => {
        const body = request.body as {
          name: string;
          modeKey: string;
          city?: string;
          mapId?: string | null;
          challengeSetId?: string | null;
          centerLat?: number;
          centerLng?: number;
          defaultZoom?: number;
          winCondition?: Array<Record<string, unknown>>;
          settings?: Record<string, unknown>;
        };

        validateWinConditions(body.winCondition);

        if (body.challengeSetId) {
          await getChallengeSetByIdOrThrow(db, body.challengeSetId);
        }

        const mapDefaults = body.mapId ? await applyMapDefaultsToGame(db, body.mapId) : null;
        const centerLat = body.centerLat ?? mapDefaults?.centerLat;
        const centerLng = body.centerLng ?? mapDefaults?.centerLng;
        const defaultZoom = body.defaultZoom ?? mapDefaults?.defaultZoom;

        if (centerLat === undefined || centerLng === undefined || defaultZoom === undefined) {
          throw new AppError(errorCodes.validationError, {
            message: 'Game requires centerLat, centerLng, and defaultZoom unless mapId is provided.',
          });
        }

        const [game] = await db
          .insert(games)
          .values({
            mapId: body.mapId ?? null,
            challengeSetId: body.challengeSetId ?? null,
            name: body.name,
            modeKey: body.modeKey,
            city: body.city ?? mapDefaults?.city ?? null,
            centerLat: centerLat.toString(),
            centerLng: centerLng.toString(),
            defaultZoom,
            boundary: mapDefaults?.boundary
              ? sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(mapDefaults.boundary)}), 4326)::geometry(Polygon,4326)`
              : null,
            winCondition: body.winCondition ?? [],
            settings: body.settings ?? {},
          })
          .returning();

        return {
          gameId: game.id,
          statusCode: 201,
          body: { game: serializeGameRecord(game) },
        };
      });
    },
  );

  app.get(
    '/game/:id',
    {
      schema: {
        params: paramsWithGameIdSchema,
      },
    },
    async (request, reply) => {
      const game = await getGameById(app.db, (request.params as { id: string }).id);
      reply.send({ game: serializeGameRecord(game) });
    },
  );

  app.patch(
    '/game/:id',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: paramsWithGameIdSchema,
        body: gameUpdateBodySchema,
      },
    },
    async (request, reply) => {
      await executeIdempotentMutation(app, request, reply, async (db) => {
        const { id } = request.params as { id: string };
        const existingGame = await getGameById(db, id);
        const body = request.body as {
          name?: string;
          city?: string;
          mapId?: string | null;
          challengeSetId?: string | null;
          centerLat?: number;
          centerLng?: number;
          defaultZoom?: number;
          winCondition?: Array<Record<string, unknown>>;
          settings?: Record<string, unknown>;
        };

        validateWinConditions(body.winCondition);

        if ((body.mapId !== undefined || body.challengeSetId !== undefined) && existingGame.status !== 'setup') {
          throw new AppError(errorCodes.validationError, {
            message: 'Map and challenge set assignment can only change while the game is in setup.',
          });
        }

        const nextMapId = body.mapId === undefined ? existingGame.mapId : body.mapId;
        const nextChallengeSetId = body.challengeSetId === undefined ? existingGame.challengeSetId : body.challengeSetId;
        if (nextChallengeSetId) {
          await getChallengeSetByIdOrThrow(db, nextChallengeSetId);
        }
        const mapDefaults = nextMapId ? await applyMapDefaultsToGame(db, nextMapId) : null;

        const [game] = await db
          .update(games)
          .set({
            mapId: nextMapId ?? null,
            challengeSetId: nextChallengeSetId ?? null,
            name: body.name ?? existingGame.name,
            city: body.city ?? mapDefaults?.city ?? existingGame.city,
            centerLat: body.centerLat === undefined ? (mapDefaults ? String(mapDefaults.centerLat) : existingGame.centerLat) : body.centerLat.toString(),
            centerLng: body.centerLng === undefined ? (mapDefaults ? String(mapDefaults.centerLng) : existingGame.centerLng) : body.centerLng.toString(),
            defaultZoom: body.defaultZoom ?? mapDefaults?.defaultZoom ?? existingGame.defaultZoom,
            boundary: body.mapId === undefined
              ? existingGame.boundary
              : (mapDefaults?.boundary ? sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(mapDefaults.boundary)}), 4326)::geometry(Polygon,4326)` : null),
            winCondition: body.winCondition ?? existingGame.winCondition,
            settings: body.settings ?? existingGame.settings,
            updatedAt: new Date(),
          })
          .where(eq(games.id, id))
          .returning();

        return {
          gameId: id,
          statusCode: 200,
          body: { game: serializeGameRecord(game) },
        };
      });
    },
  );

  registerLifecycleRoute(app, 'start');
  registerLifecycleRoute(app, 'pause');
  registerLifecycleRoute(app, 'resume');
  registerLifecycleRoute(app, 'end');

  app.post(
    '/game/:id/teams',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: paramsWithGameIdSchema,
        body: teamCreateBodySchema,
      },
    },
    async (request, reply) => {
      await executeIdempotentMutation(app, request, reply, async (db) => {
        const { id } = request.params as { id: string };
        await getGameById(db, id);
        const body = request.body as {
          name: string;
          color: string;
          icon?: string;
          metadata?: Record<string, unknown>;
        };

        const team = await createTeamWithUniqueJoinCode(db, {
          gameId: id,
          name: body.name,
          color: body.color,
          icon: body.icon ?? null,
          metadata: body.metadata ?? {},
        });

        return {
          gameId: id,
          statusCode: 201,
          body: { team: serializeTeam(team) },
        };
      });
    },
  );

  app.get(
    '/game/:id/teams',
    {
      schema: {
        params: paramsWithGameIdSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getGameById(app.db, id);

      const gameTeams = await app.db
        .select()
        .from(teams)
        .where(eq(teams.gameId, id))
        .orderBy(teams.createdAt);

      reply.send({ teams: gameTeams.map(serializeTeam) });
    },
  );

  app.patch(
    '/teams/:id',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: paramsWithGameIdSchema,
        body: teamUpdateBodySchema,
      },
    },
    async (request, reply) => {
      await executeIdempotentMutation(app, request, reply, async (db) => {
        const { id } = request.params as { id: string };
        const [existingTeam] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);

        if (!existingTeam) {
          throw new AppError(errorCodes.teamNotFound, { message: 'Team not found.' });
        }

        const body = request.body as {
          name?: string;
          color?: string;
          icon?: string | null;
          metadata?: Record<string, unknown>;
        };

        const [team] = await db
          .update(teams)
          .set({
            name: body.name ?? existingTeam.name,
            color: body.color ?? existingTeam.color,
            icon: body.icon === undefined ? existingTeam.icon : body.icon,
            metadata: body.metadata ?? existingTeam.metadata,
          })
          .where(eq(teams.id, id))
          .returning();

        return {
          gameId: team.gameId,
          statusCode: 200,
          body: { team: serializeTeam(team) },
        };
      });
    },
  );
};

function registerLifecycleRoute(app: FastifyInstance, transition: LifecycleTransition) {
  app.post(
    `/game/:id/${transition}`,
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: paramsWithGameIdSchema,
      },
    },
    async (request, reply) => {
      let broadcastPayload:
        | {
            gameId: string;
            modeKey: string;
            stateVersion: number;
            game: ReturnType<typeof serializeGameRecord>;
          }
        | null = null;

      await executeIdempotentMutation(
        app,
        request,
        reply,
        async (db) => {
          const { id } = request.params as { id: string };
          const result = await transitionGameLifecycle(db, app.modeRegistry, id, transition);
          const serializedGame = serializeGameRecord(result.game);

          broadcastPayload = {
            gameId: id,
            modeKey: serializedGame.modeKey,
            stateVersion: result.stateVersion,
            game: serializedGame,
          };

          return {
            gameId: id,
            statusCode: 200,
            body: { game: serializedGame },
            responseHeaders: {
              [STATE_VERSION_HEADER]: String(result.stateVersion),
            },
          };
        },
        async () => {
          if (!broadcastPayload) {
            return;
          }

          await app.broadcaster.send({
            gameId: broadcastPayload.gameId,
            modeKey: broadcastPayload.modeKey,
            eventType: getLifecycleSocketEventType(transition),
            stateVersion: broadcastPayload.stateVersion,
            payload: {
              game: broadcastPayload.game,
            },
          });
        },
      );
    },
  );
}

function getLifecycleSocketEventType(transition: LifecycleTransition) {
  switch (transition) {
    case 'start':
      return socketServerEventTypes.gameStarted;
    case 'pause':
      return socketServerEventTypes.gamePaused;
    case 'resume':
      return socketServerEventTypes.gameResumed;
    case 'end':
      return socketServerEventTypes.gameEnded;
  }
}

async function createTeamWithUniqueJoinCode(
  db: DatabaseClient,
  values: {
    gameId: string;
    name: string;
    color: string;
    icon: string | null;
    metadata: Record<string, unknown>;
  },
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const [team] = await db
        .insert(teams)
        .values({
          ...values,
          joinCode: generateJoinCode(),
        })
        .returning();

      return team;
    } catch (error) {
      if (isJoinCodeConstraintError(error)) {
        continue;
      }

      throw error;
    }
  }

  throw new Error('Unable to generate a unique team join code after repeated attempts.');
}

function isJoinCodeConstraintError(error: unknown) {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && 'constraint' in error
      && (error as { code?: string }).code === '23505'
      && (error as { constraint?: string }).constraint === 'teams_game_join_code_idx',
  );
}

function serializeTeam(team: typeof teams.$inferSelect) {
  return team;
}

function validateWinConditions(winConditions?: Array<Record<string, unknown>>) {
  if (!winConditions) {
    return;
  }

  for (const condition of winConditions) {
    switch (condition.type) {
      case 'all_zones':
        break;
      case 'zone_majority':
        if (typeof condition.threshold !== 'number') {
          throw invalidWinConditionError();
        }
        break;
      case 'time_limit':
        if (!Number.isInteger(condition.duration_minutes) || (condition.duration_minutes as number) < 1) {
          throw invalidWinConditionError();
        }
        break;
      case 'score_threshold':
        if (!Number.isInteger(condition.target) || (condition.target as number) < 1) {
          throw invalidWinConditionError();
        }
        break;
      default:
        throw invalidWinConditionError();
    }
  }
}

function invalidWinConditionError() {
  return new AppError(errorCodes.validationError, {
    message: 'winCondition must be an array of valid win condition objects.',
  });
}
