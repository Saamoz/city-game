import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { EVENT_TYPE_VALUES, errorCodes, type GameEventType } from '@city-game/shared';
import { eq } from 'drizzle-orm';
import { games } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { getEventsSince, getRecentEvents } from '../services/event-service.js';

const gameParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const eventsSinceParamsSchema = {
  type: 'object',
  required: ['id', 'version'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    version: { type: 'integer', minimum: 0 },
  },
} as const;

const recentEventsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    eventType: { type: 'string', enum: [...EVENT_TYPE_VALUES] },
  },
} as const;

const sinceEventsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  },
} as const;

export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/game/:id/events',
    {
      schema: {
        params: gameParamsSchema,
        querystring: recentEventsQuerySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { limit?: number; eventType?: GameEventType };
      await getGameById(app, id);

      const events = await getRecentEvents(app.db, {
        gameId: id,
        limit: query.limit,
        eventType: query.eventType,
      });

      reply.send({ events });
    },
  );

  app.get(
    '/game/:id/events/since/:version',
    {
      schema: {
        params: eventsSinceParamsSchema,
        querystring: sinceEventsQuerySchema,
      },
    },
    async (request, reply) => {
      const { id, version } = request.params as { id: string; version: number };
      const query = request.query as { limit?: number };
      const result = await getEventsSince(app.db, {
        gameId: id,
        sinceVersion: version,
        limit: query.limit,
      });

      reply.send(result);
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
