import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { GeoJsonFeatureCollection, GeoJsonPolygon, JsonObject } from '@city-game/shared';
import { errorCodes } from '@city-game/shared';
import { eq } from 'drizzle-orm';
import { games } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { OsmPreviewProperties } from '../services/osm-import-service.js';
import {
  createZone,
  deleteZoneById,
  getZoneById,
  importZones,
  listZonesByGame,
  updateZone,
} from '../services/spatial-service.js';

const polygonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'coordinates'],
  properties: {
    type: { type: 'string', const: 'Polygon' },
    coordinates: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'array',
        minItems: 4,
        items: {
          type: 'array',
          minItems: 2,
          maxItems: 3,
          items: { type: 'number' },
        },
      },
    },
  },
} as const;

const zoneBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'geometry'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    geometry: polygonSchema,
    ownerTeamId: { type: 'string', format: 'uuid' },
    pointValue: { type: 'integer', minimum: 1 },
    claimRadiusMeters: { type: 'integer', minimum: 0 },
    maxGpsErrorMeters: { type: 'integer', minimum: 0 },
    isDisabled: { type: 'boolean' },
    metadata: {
      type: 'object',
      additionalProperties: true,
    },
  },
} as const;

const zoneUpdateBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    geometry: polygonSchema,
    ownerTeamId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    pointValue: { type: 'integer', minimum: 1 },
    claimRadiusMeters: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    maxGpsErrorMeters: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    isDisabled: { type: 'boolean' },
    metadata: {
      type: 'object',
      additionalProperties: true,
    },
  },
  minProperties: 1,
} as const;

const zoneImportBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'features'],
  properties: {
    type: { type: 'string', const: 'FeatureCollection' },
    features: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'geometry'],
        properties: {
          type: { type: 'string', const: 'Feature' },
          geometry: polygonSchema,
          properties: {
            type: 'object',
            additionalProperties: true,
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 255 },
              ownerTeamId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
              pointValue: { type: 'integer', minimum: 1 },
              claimRadiusMeters: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
              maxGpsErrorMeters: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
              isDisabled: { type: 'boolean' },
              metadata: {
                type: 'object',
                additionalProperties: true,
              },
            },
          },
        },
      },
    },
  },
} as const;

const osmImportBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['city'],
  properties: {
    city: { type: 'string', minLength: 1, maxLength: 255 },
  },
} as const;

const gameParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const zoneParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export const zoneRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/game/:id/zones',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: gameParamsSchema,
        body: zoneBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getGameById(app, id);

      const body = request.body as {
        name: string;
        geometry: GeoJsonPolygon;
        ownerTeamId?: string;
        pointValue?: number;
        claimRadiusMeters?: number;
        maxGpsErrorMeters?: number;
        isDisabled?: boolean;
        metadata?: JsonObject;
      };

      const zone = await createZone(app.db, {
        gameId: id,
        name: body.name,
        geometry: body.geometry,
        ownerTeamId: body.ownerTeamId ?? null,
        pointValue: body.pointValue,
        claimRadiusMeters: body.claimRadiusMeters,
        maxGpsErrorMeters: body.maxGpsErrorMeters,
        isDisabled: body.isDisabled,
        metadata: body.metadata,
      });

      reply.status(201).send({ zone });
    },
  );

  app.post(
    '/game/:id/zones/import',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: gameParamsSchema,
        body: zoneImportBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getGameById(app, id);

      const body = request.body as GeoJsonFeatureCollection<GeoJsonPolygon>;
      const importedZones = await importZones(app.db, id, body.features);
      reply.status(201).send({ zones: importedZones });
    },
  );

  app.post(
    '/game/:id/zones/import-osm',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: gameParamsSchema,
        body: osmImportBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getGameById(app, id);

      const body = request.body as { city: string };
      const featureCollection = await app.osmImportService.previewAdministrativeBoundaries({
        city: body.city,
      });

      reply.send(featureCollection as GeoJsonFeatureCollection<GeoJsonPolygon, OsmPreviewProperties>);
    },
  );

  app.get(
    '/game/:id/zones',
    {
      schema: {
        params: gameParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getGameById(app, id);
      reply.send({ zones: await listZonesByGame(app.db, id) });
    },
  );

  app.get(
    '/zones/:id',
    {
      schema: {
        params: zoneParamsSchema,
      },
    },
    async (request, reply) => {
      const zone = await getZoneById(app.db, (request.params as { id: string }).id);

      if (!zone) {
        throw new AppError(errorCodes.validationError, {
          message: 'Zone not found.',
        });
      }

      reply.send({ zone });
    },
  );

  app.patch(
    '/zones/:id',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: zoneParamsSchema,
        body: zoneUpdateBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        geometry?: GeoJsonPolygon;
        ownerTeamId?: string | null;
        pointValue?: number;
        claimRadiusMeters?: number | null;
        maxGpsErrorMeters?: number | null;
        isDisabled?: boolean;
        metadata?: JsonObject;
      };

      const zone = await updateZone(app.db, id, body);
      reply.send({ zone });
    },
  );

  app.delete(
    '/zones/:id',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: zoneParamsSchema,
      },
    },
    async (request, reply) => {
      const deleted = await deleteZoneById(app.db, (request.params as { id: string }).id);

      if (!deleted) {
        throw new AppError(errorCodes.validationError, {
          message: 'Zone not found.',
        });
      }

      reply.status(204).send();
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
