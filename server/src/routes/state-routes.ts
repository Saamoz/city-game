import type { FastifyPluginAsync } from 'fastify';
import { buildGameStateSnapshot } from '../services/state-service.js';

const gameParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export const stateRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/game/:id/map-state',
    {
      preHandler: [app.authenticate],
      schema: {
        params: gameParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const snapshot = await buildGameStateSnapshot(app.db, app.modeRegistry, {
        gameId: id,
        playerId: request.player!.id,
      });

      reply.send({ snapshot });
    },
  );
};
