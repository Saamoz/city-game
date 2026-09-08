import { errorCodes } from '@city-game/shared';
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../lib/errors.js';
import { buildGameRecap } from '../services/game-recap-service.js';

const gameParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export const gameRecapRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/game/:id/recap',
    { preHandler: [app.authenticate], schema: { params: gameParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (request.player?.gameId !== id) {
        throw new AppError(errorCodes.unauthorized, { message: 'This recap belongs to another game.' });
      }
      const recap = await buildGameRecap(app.db, app.modeRegistry, id);
      reply.send({ recap });
    },
  );
};
