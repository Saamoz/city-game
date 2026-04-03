import type { FastifyPluginAsync } from 'fastify';
import type { GeoJsonPoint, JsonObject } from '@city-game/shared';
import {
  createChallengeSet,
  createChallengeSetItem,
  deleteChallengeSetById,
  deleteChallengeSetItemById,
  getChallengeSetByIdOrThrow,
  getChallengeSetItemByIdOrThrow,
  listChallengeSetItems,
  listChallengeSets,
  updateChallengeSet,
  updateChallengeSetItem,
} from '../services/challenge-set-service.js';

const pointPositionSchema = {
  type: 'array',
  minItems: 2,
  maxItems: 3,
  items: { type: 'number' },
} as const;

const pointSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'coordinates'],
  properties: {
    type: { type: 'string', const: 'Point' },
    coordinates: pointPositionSchema,
  },
} as const;

const challengeSetBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const;

const challengeSetUpdateBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const;

const challengeSetItemBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description'],
  properties: {
    mapZoneId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    mapPoint: { anyOf: [pointSchema, { type: 'null' }] },
    title: { type: 'string', minLength: 1, maxLength: 255 },
    description: { type: 'string', minLength: 1 },
    config: { type: 'object', additionalProperties: true },
    scoring: { type: 'object', additionalProperties: { type: 'number' } },
    difficulty: { anyOf: [{ type: 'string', enum: ['easy', 'medium', 'hard'] }, { type: 'null' }] },
    sortOrder: { type: 'integer' },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const;

const challengeSetItemUpdateBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    mapZoneId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    mapPoint: { anyOf: [pointSchema, { type: 'null' }] },
    title: { type: 'string', minLength: 1, maxLength: 255 },
    description: { type: 'string', minLength: 1 },
    config: { type: 'object', additionalProperties: true },
    scoring: { type: 'object', additionalProperties: { type: 'number' } },
    difficulty: { anyOf: [{ type: 'string', enum: ['easy', 'medium', 'hard'] }, { type: 'null' }] },
    sortOrder: { type: 'integer' },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const;

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export const challengeSetRoutes: FastifyPluginAsync = async (app) => {
  app.get('/challenge-sets', async (_request, reply) => {
    reply.send({ challengeSets: await listChallengeSets(app.db) });
  });

  app.post('/challenge-sets', { schema: { body: challengeSetBodySchema } }, async (request, reply) => {
    const body = request.body as { name: string; description?: string | null; metadata?: JsonObject };
    const challengeSet = await createChallengeSet(app.db, body);
    reply.code(201).send({ challengeSet });
  });

  app.get('/challenge-sets/:id', { schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.send({ challengeSet: await getChallengeSetByIdOrThrow(app.db, id) });
  });

  app.patch('/challenge-sets/:id', { schema: { params: idParamsSchema, body: challengeSetUpdateBodySchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; description?: string | null; metadata?: JsonObject };
    reply.send({ challengeSet: await updateChallengeSet(app.db, id, body) });
  });

  app.delete('/challenge-sets/:id', { schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await deleteChallengeSetById(app.db, id);
    if (!deleted) {
      reply.code(404).send({ error: { code: 'CHALLENGE_SET_NOT_FOUND', message: 'Challenge set not found.' } });
      return;
    }
    reply.code(204).send();
  });

  app.get('/challenge-sets/:id/items', { schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await getChallengeSetByIdOrThrow(app.db, id);
    reply.send({ items: await listChallengeSetItems(app.db, id) });
  });

  app.post('/challenge-sets/:id/items', { schema: { params: idParamsSchema, body: challengeSetItemBodySchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      mapZoneId?: string | null;
      mapPoint?: GeoJsonPoint | null;
      title: string;
      description: string;
      config?: JsonObject;
      scoring?: Record<string, number>;
      difficulty?: string | null;
      sortOrder?: number;
      metadata?: JsonObject;
    };
    const item = await createChallengeSetItem(app.db, { ...body, setId: id });
    reply.code(201).send({ item });
  });

  app.patch('/challenge-set-items/:id', { schema: { params: idParamsSchema, body: challengeSetItemUpdateBodySchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      mapZoneId?: string | null;
      mapPoint?: GeoJsonPoint | null;
      title?: string;
      description?: string;
      config?: JsonObject;
      scoring?: Record<string, number>;
      difficulty?: string | null;
      sortOrder?: number;
      metadata?: JsonObject;
    };
    reply.send({ item: await updateChallengeSetItem(app.db, id, body) });
  });

  app.delete('/challenge-set-items/:id', { schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const item = await getChallengeSetItemByIdOrThrow(app.db, id);
    const deleted = await deleteChallengeSetItemById(app.db, id);
    if (!deleted) {
      reply.code(404).send({ error: { code: 'VALIDATION_ERROR', message: 'Challenge set item not found.' } });
      return;
    }
    reply.code(200).send({ deletedItemId: id, challengeSetId: item.setId });
  });
};
