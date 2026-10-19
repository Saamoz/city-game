import type { FastifyPluginAsync } from 'fastify';
import { CLUE_IMAGE_MAX_DIMENSION, CLUE_MAX_FRAGMENT_COUNT, STATE_VERSION_HEADER, type ClueImageUpload } from '@city-game/shared';
import {
  addClueImage,
  deleteClueImage,
  getAdminClueStatus,
  getClueFragmentImage,
  getTeamClue,
  setClueRevealed,
} from '../services/clue-service.js';
import { executeIdempotentMutation } from '../services/idempotency-service.js';
import { broadcastFullStateToGame } from '../socket/admin-sync.js';

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const fragmentParamsSchema = {
  type: 'object',
  required: ['id', 'index'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    index: { type: 'integer', minimum: 0, maximum: CLUE_MAX_FRAGMENT_COUNT - 1 },
  },
} as const;

const uploadBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['width', 'height', 'thumbnail', 'tiles'],
  properties: {
    width: { type: 'integer', minimum: 1, maximum: CLUE_IMAGE_MAX_DIMENSION },
    height: { type: 'integer', minimum: 1, maximum: CLUE_IMAGE_MAX_DIMENSION },
    thumbnail: { type: 'string' },
    tiles: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: CLUE_MAX_FRAGMENT_COUNT },
  },
} as const;

const revealBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['revealed'],
  properties: { revealed: { type: 'boolean' } },
} as const;

export const clueRoutes: FastifyPluginAsync = async (app) => {
  // Players: the fragments their team has found (or everyone's, once revealed).
  app.get('/game/:id/clue', { preHandler: [app.authenticate], schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.send({ clue: await getTeamClue(app.db, id, getViewerTeamId(request.player, id)) });
  });

  app.get('/game/:id/clue/fragments/:index', { preHandler: [app.authenticate], schema: { params: fragmentParamsSchema } }, async (request, reply) => {
    const { id, index } = request.params as { id: string; index: number };
    const tile = await getClueFragmentImage(app.db, id, getViewerTeamId(request.player, id), index);
    reply.header('Cache-Control', 'private, max-age=86400').type(tile.contentType).send(tile.data);
  });

  // Admin: the candidate pictures, never which one was picked.
  app.get('/game/:id/clue/admin', { preHandler: [app.requireAdmin], schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.send({ clue: await getAdminClueStatus(app.db, id) });
  });

  app.post('/game/:id/clue/images', { preHandler: [app.requireAdmin], schema: { params: idParamsSchema, body: uploadBodySchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await executeIdempotentMutation(app, request, reply, async (db) => ({
      gameId: id,
      statusCode: 201,
      body: { image: await addClueImage(db, id, request.body as ClueImageUpload) },
    }));
  });

  app.delete('/clue/images/:id', { preHandler: [app.requireAdmin], schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await executeIdempotentMutation(app, request, reply, async (db) => ({
      gameId: await deleteClueImage(db, id),
      statusCode: 204,
    }));
  });

  app.post('/game/:id/clue/reveal', { preHandler: [app.requireAdmin], schema: { params: idParamsSchema, body: revealBodySchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { revealed } = request.body as { revealed: boolean };
    await executeIdempotentMutation(app, request, reply, async (db) => {
      const result = await setClueRevealed(db, id, revealed);
      return {
        gameId: id,
        statusCode: 200,
        body: result.body,
        responseHeaders: { [STATE_VERSION_HEADER]: String(result.stateVersion) },
      };
    }, async () => {
      await broadcastFullStateToGame(app, id);
    });
  });
};

function getViewerTeamId(player: { gameId: string; teamId: string | null } | null | undefined, gameId: string): string | null {
  return player && player.gameId === gameId ? player.teamId : null;
}
