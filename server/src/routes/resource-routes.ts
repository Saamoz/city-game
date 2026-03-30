import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { RESOURCE_TYPE_VALUES, errorCodes, type ResourceType } from '@city-game/shared';
import { and, eq } from 'drizzle-orm';
import { games, teams } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { getAllBalances, getHistory, getTeamBalances } from '../services/resource-service.js';

const gameParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const resourceTeamParamsSchema = {
  type: 'object',
  required: ['id', 'teamId'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    teamId: { type: 'string', format: 'uuid' },
  },
} as const;

const historyQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    resourceType: { type: 'string', enum: [...RESOURCE_TYPE_VALUES] },
  },
} as const;

export const resourceRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/game/:id/resources',
    {
      schema: {
        params: gameParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getGameById(app, id);

      const resources = await getAllBalances(app.db, id);
      reply.send({ resources });
    },
  );

  app.get(
    '/game/:id/resources/:teamId',
    {
      schema: {
        params: resourceTeamParamsSchema,
      },
    },
    async (request, reply) => {
      const { id, teamId } = request.params as { id: string; teamId: string };
      await getGameById(app, id);
      await assertTeamInGame(app, id, teamId);

      const resources = await getTeamBalances(app.db, {
        gameId: id,
        teamId,
      });

      reply.send({ teamId, resources });
    },
  );

  app.get(
    '/game/:id/resources/:teamId/history',
    {
      schema: {
        params: resourceTeamParamsSchema,
        querystring: historyQuerySchema,
      },
    },
    async (request, reply) => {
      const { id, teamId } = request.params as { id: string; teamId: string };
      const query = request.query as { limit?: number; resourceType?: ResourceType };
      await getGameById(app, id);
      await assertTeamInGame(app, id, teamId);

      const history = await getHistory(app.db, {
        gameId: id,
        teamId,
        limit: query.limit,
        resourceType: query.resourceType,
      });

      reply.send({ teamId, history });
    },
  );
};

async function getGameById(app: FastifyInstance, gameId: string) {
  const [game] = await app.db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).limit(1);

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }

  return game;
}

async function assertTeamInGame(app: FastifyInstance, gameId: string, teamId: string) {
  const [team] = await app.db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.gameId, gameId)))
    .limit(1);

  if (!team) {
    throw new AppError(errorCodes.teamNotFound);
  }
}
