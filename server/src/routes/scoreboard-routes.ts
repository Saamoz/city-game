import type { FastifyPluginAsync } from 'fastify';
import { getScoreboard } from '../services/scoreboard-service.js';

const gameParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export const scoreboardRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/game/:id/scoreboard',
    {
      schema: {
        params: gameParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const scoreboard = await getScoreboard(app.db, app.modeRegistry, id);

      reply.send({ scoreboard });
    },
  );
};
