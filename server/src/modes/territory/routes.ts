import type { FastifyPluginAsync } from 'fastify';
import { errorCodes } from '@city-game/shared';
import { buildErrorResponse } from '../../lib/errors.js';
import { gpsPayloadSchema } from '../../middleware/gps-validation.js';

const challengeParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const notImplementedResponse = buildErrorResponse(errorCodes.internalServerError, {
  message: 'Territory mode action endpoints are not implemented yet.',
});

export const territoryRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/challenges/:id/claim',
    {
      preHandler: [app.authenticate, app.requireTeam, app.validateGps],
      schema: {
        params: challengeParamsSchema,
        body: gpsPayloadSchema,
      },
    },
    async (_request, reply) => {
      reply.status(501).send(notImplementedResponse);
    },
  );

  app.post(
    '/challenges/:id/complete',
    {
      preHandler: [app.authenticate, app.requireTeam],
      schema: {
        params: challengeParamsSchema,
      },
    },
    async (_request, reply) => {
      reply.status(501).send(notImplementedResponse);
    },
  );

  app.post(
    '/challenges/:id/release',
    {
      preHandler: [app.authenticate, app.requireTeam],
      schema: {
        params: challengeParamsSchema,
      },
    },
    async (_request, reply) => {
      reply.status(501).send(notImplementedResponse);
    },
  );
};
