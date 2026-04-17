import type { FastifyPluginAsync } from 'fastify';
import { getGameById } from '../services/game-service.js';
import { buildGameStateSnapshot } from '../services/state-service.js';
import { listTeamLocationsByGame } from '../services/team-location-service.js';

const gameParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export const stateRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/game/:id/team-locations',
    {
      schema: {
        params: gameParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getGameById(app.db, id);
      const teamLocations = await listTeamLocationsByGame(app.db, id);
      reply.send({ teamLocations });
    },
  );

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
