import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { desc, eq, ne } from 'drizzle-orm';
import { GAME_MODE_KEYS, errorCodes } from '@city-game/shared';
import { games, teams } from '../db/schema.js';
import { AppError, buildErrorResponse } from '../lib/errors.js';
import { generateJoinCode } from '../lib/join-code.js';

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
  required: ['name', 'modeKey', 'centerLat', 'centerLng', 'defaultZoom'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    modeKey: { type: 'string', enum: [...GAME_MODE_KEYS] },
    city: { type: 'string', minLength: 1, maxLength: 255 },
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

const paramsWithGameIdSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export const gameRoutes: FastifyPluginAsync = async (app) => {
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

    reply.send({ game: serializeGame(game) });
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
      const body = request.body as {
        name: string;
        modeKey: string;
        city?: string;
        centerLat: number;
        centerLng: number;
        defaultZoom: number;
        winCondition?: Array<Record<string, unknown>>;
        settings?: Record<string, unknown>;
      };

      validateWinConditions(body.winCondition);

      const [game] = await app.db
        .insert(games)
        .values({
          name: body.name,
          modeKey: body.modeKey,
          city: body.city ?? null,
          centerLat: body.centerLat.toString(),
          centerLng: body.centerLng.toString(),
          defaultZoom: body.defaultZoom,
          winCondition: body.winCondition ?? [],
          settings: body.settings ?? {},
        })
        .returning();

      reply.status(201).send({ game: serializeGame(game) });
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
      const game = await getGameById(app, (request.params as { id: string }).id);
      reply.send({ game: serializeGame(game) });
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
      const { id } = request.params as { id: string };
      const existingGame = await getGameById(app, id);
      const body = request.body as {
        name?: string;
        city?: string;
        centerLat?: number;
        centerLng?: number;
        defaultZoom?: number;
        winCondition?: Array<Record<string, unknown>>;
        settings?: Record<string, unknown>;
      };

      validateWinConditions(body.winCondition);

      const [game] = await app.db
        .update(games)
        .set({
          name: body.name ?? existingGame.name,
          city: body.city ?? existingGame.city,
          centerLat: body.centerLat === undefined ? existingGame.centerLat : body.centerLat.toString(),
          centerLng: body.centerLng === undefined ? existingGame.centerLng : body.centerLng.toString(),
          defaultZoom: body.defaultZoom ?? existingGame.defaultZoom,
          winCondition: body.winCondition ?? existingGame.winCondition,
          settings: body.settings ?? existingGame.settings,
          updatedAt: new Date(),
        })
        .where(eq(games.id, id))
        .returning();

      reply.send({ game: serializeGame(game) });
    },
  );

  app.post(
    '/game/:id/start',
    {
      preHandler: [app.requireAdmin],
      schema: { params: paramsWithGameIdSchema },
    },
    async (_request, reply) => {
      reply.status(501).send(
        buildErrorResponse(errorCodes.internalServerError, {
          message: 'Game lifecycle endpoints are not implemented yet.',
        }),
      );
    },
  );

  app.post(
    '/game/:id/pause',
    {
      preHandler: [app.requireAdmin],
      schema: { params: paramsWithGameIdSchema },
    },
    async (_request, reply) => {
      reply.status(501).send(
        buildErrorResponse(errorCodes.internalServerError, {
          message: 'Game lifecycle endpoints are not implemented yet.',
        }),
      );
    },
  );

  app.post(
    '/game/:id/end',
    {
      preHandler: [app.requireAdmin],
      schema: { params: paramsWithGameIdSchema },
    },
    async (_request, reply) => {
      reply.status(501).send(
        buildErrorResponse(errorCodes.internalServerError, {
          message: 'Game lifecycle endpoints are not implemented yet.',
        }),
      );
    },
  );

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
      const { id } = request.params as { id: string };
      await getGameById(app, id);
      const body = request.body as {
        name: string;
        color: string;
        icon?: string;
        metadata?: Record<string, unknown>;
      };

      const team = await createTeamWithUniqueJoinCode(app, {
        gameId: id,
        name: body.name,
        color: body.color,
        icon: body.icon ?? null,
        metadata: body.metadata ?? {},
      });

      reply.status(201).send({ team: serializeTeam(team) });
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
      await getGameById(app, id);

      const gameTeams = await app.db
        .select()
        .from(teams)
        .where(eq(teams.gameId, id))
        .orderBy(teams.createdAt);

      reply.send({ teams: gameTeams.map(serializeTeam) });
    },
  );
};

async function getGameById(app: FastifyInstance, gameId: string) {
  const [game] = await app.db.select().from(games).where(eq(games.id, gameId)).limit(1);

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }

  return game;
}

async function createTeamWithUniqueJoinCode(
  app: FastifyInstance,
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
      const [team] = await app.db
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
    error &&
      typeof error === 'object' &&
      'code' in error &&
      'constraint' in error &&
      (error as { code?: string }).code === '23505' &&
      (error as { constraint?: string }).constraint === 'teams_game_join_code_idx',
  );
}

function serializeGame(game: typeof games.$inferSelect) {
  return {
    ...game,
    centerLat: Number(game.centerLat),
    centerLng: Number(game.centerLng),
  };
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
