import type { FastifyPluginAsync } from 'fastify';
import type { GeoJsonFeatureCollection, GeoJsonGeometry, GeoJsonPolygon, JsonObject } from '@city-game/shared';
import { errorCodes } from '@city-game/shared';
import { AppError } from '../lib/errors.js';
import type { OsmPreviewProperties } from '../services/osm-import-service.js';
import {
  createMap,
  createMapZone,
  deleteMapZoneById,
  getMapByIdOrThrow,
  getMapZoneById,
  importMapZones,
  listMaps,
  listMapZones,
  mergeMapZonesById,
  splitMapZoneById,
  updateMap,
  updateMapZone,
} from '../services/map-service.js';

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

const lineStringSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'coordinates'],
  properties: {
    type: { type: 'string', const: 'LineString' },
    coordinates: {
      type: 'array',
      minItems: 2,
      items: pointPositionSchema,
    },
  },
} as const;

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
        items: pointPositionSchema,
      },
    },
  },
} as const;

const multiPolygonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'coordinates'],
  properties: {
    type: { type: 'string', const: 'MultiPolygon' },
    coordinates: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'array',
          minItems: 4,
          items: pointPositionSchema,
        },
      },
    },
  },
} as const;

const geometrySchema = {
  oneOf: [pointSchema, lineStringSchema, polygonSchema, multiPolygonSchema],
} as const;

const mapBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'centerLat', 'centerLng', 'defaultZoom'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    city: { anyOf: [{ type: 'string', minLength: 1, maxLength: 255 }, { type: 'null' }] },
    centerLat: { type: 'number' },
    centerLng: { type: 'number' },
    defaultZoom: { type: 'integer' },
    boundary: { anyOf: [polygonSchema, { type: 'null' }] },
    metadata: {
      type: 'object',
      additionalProperties: true,
    },
  },
} as const;

const mapUpdateBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    city: { anyOf: [{ type: 'string', minLength: 1, maxLength: 255 }, { type: 'null' }] },
    centerLat: { type: 'number' },
    centerLng: { type: 'number' },
    defaultZoom: { type: 'integer' },
    boundary: { anyOf: [polygonSchema, { type: 'null' }] },
    metadata: {
      type: 'object',
      additionalProperties: true,
    },
  },
} as const;

const mapZoneBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'geometry'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    geometry: geometrySchema,
    pointValue: { type: 'integer', minimum: 1 },
    claimRadiusMeters: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    maxGpsErrorMeters: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    isDisabled: { type: 'boolean' },
    metadata: {
      type: 'object',
      additionalProperties: true,
    },
  },
} as const;

const mapZoneUpdateBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    geometry: geometrySchema,
    pointValue: { type: 'integer', minimum: 1 },
    claimRadiusMeters: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    maxGpsErrorMeters: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    isDisabled: { type: 'boolean' },
    metadata: {
      type: 'object',
      additionalProperties: true,
    },
  },
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
          geometry: geometrySchema,
          properties: {
            type: 'object',
            additionalProperties: true,
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 255 },
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
  properties: {
    city: { type: 'string', minLength: 1, maxLength: 255 },
  },
} as const;

const mapParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const mapZoneParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const mergeMapZonesBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['zoneIds'],
  properties: {
    zoneIds: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: { type: 'string', format: 'uuid' },
    },
    name: { type: 'string', minLength: 1, maxLength: 255 },
  },
} as const;

export const mapRoutes: FastifyPluginAsync = async (app) => {
  app.get('/maps', async (_request, reply) => {
    reply.send({ maps: await listMaps(app.db) });
  });

  app.post(
    '/maps',
    {
      schema: {
        body: mapBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as {
        name: string;
        city?: string | null;
        centerLat: number;
        centerLng: number;
        defaultZoom: number;
        boundary?: GeoJsonPolygon | null;
        metadata?: JsonObject;
      };

      const map = await createMap(app.db, body);
      reply.status(201).send({ map });
    },
  );

  app.get(
    '/maps/:id',
    {
      schema: {
        params: mapParamsSchema,
      },
    },
    async (request, reply) => {
      const map = await getMapByIdOrThrow(app.db, (request.params as { id: string }).id);
      reply.send({ map });
    },
  );

  app.patch(
    '/maps/:id',
    {
      schema: {
        params: mapParamsSchema,
        body: mapUpdateBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        city?: string | null;
        centerLat?: number;
        centerLng?: number;
        defaultZoom?: number;
        boundary?: GeoJsonPolygon | null;
        metadata?: JsonObject;
      };

      const map = await updateMap(app.db, id, body);
      reply.send({ map });
    },
  );

  app.get(
    '/maps/:id/zones',
    {
      schema: {
        params: mapParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getMapByIdOrThrow(app.db, id);
      reply.send({ zones: await listMapZones(app.db, id) });
    },
  );

  app.post(
    '/maps/:id/zones',
    {
      schema: {
        params: mapParamsSchema,
        body: mapZoneBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getMapByIdOrThrow(app.db, id);

      const body = request.body as {
        name: string;
        geometry: GeoJsonGeometry;
        pointValue?: number;
        claimRadiusMeters?: number | null;
        maxGpsErrorMeters?: number | null;
        isDisabled?: boolean;
        metadata?: JsonObject;
      };

      const zone = await createMapZone(app.db, {
        mapId: id,
        ...body,
      });

      reply.status(201).send({ zone });
    },
  );

  app.post(
    '/maps/:id/zones/import',
    {
      schema: {
        params: mapParamsSchema,
        body: zoneImportBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getMapByIdOrThrow(app.db, id);

      const body = request.body as GeoJsonFeatureCollection<GeoJsonGeometry>;
      const zones = await importMapZones(app.db, id, body.features);

      reply.status(201).send({ zones });
    },
  );

  app.post(
    '/maps/:id/zones/import-osm',
    {
      config: {
        skipIdempotency: true,
      },
      schema: {
        params: mapParamsSchema,
        body: osmImportBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const map = await getMapByIdOrThrow(app.db, id);
      const body = request.body as { city?: string };
      const city = body.city?.trim() || map.city?.trim();

      if (!city) {
        throw new AppError(errorCodes.validationError, {
          message: 'City is required for OSM preview when the map has no city set.',
        });
      }

      const featureCollection = await app.osmImportService.previewAdministrativeBoundaries({ city });
      reply.send(featureCollection as GeoJsonFeatureCollection<GeoJsonPolygon, OsmPreviewProperties>);
    },
  );

  app.patch(
    '/map-zones/:id',
    {
      schema: {
        params: mapZoneParamsSchema,
        body: mapZoneUpdateBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        geometry?: GeoJsonGeometry;
        pointValue?: number;
        claimRadiusMeters?: number | null;
        maxGpsErrorMeters?: number | null;
        isDisabled?: boolean;
        metadata?: JsonObject;
      };

      const zone = await updateMapZone(app.db, id, body);
      reply.send({ zone });
    },
  );

  app.post(
    '/map-zones/:id/split',
    {
      schema: {
        params: mapZoneParamsSchema,
        body: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                splitLine: { anyOf: [lineStringSchema, { type: 'null' }] },
              },
            },
            { type: 'null' },
          ],
        },
      },
    },
    async (request, reply) => {
      const zoneId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as { splitLine?: GeoJsonGeometry | null };
      const zones = await splitMapZoneById(app.db, zoneId, { splitLine: body.splitLine ?? null });
      reply.send({ zones });
    },
  );

  app.post(
    '/map-zones/merge',
    {
      schema: {
        body: mergeMapZonesBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as { zoneIds: [string, string]; name?: string };
      const zone = await mergeMapZonesById(app.db, body.zoneIds, { name: body.name });
      reply.send({ zone });
    },
  );

  app.delete(
    '/map-zones/:id',
    {
      schema: {
        params: mapZoneParamsSchema,
      },
    },
    async (request, reply) => {
      const zone = await getMapZoneById(app.db, (request.params as { id: string }).id);

      if (!zone) {
        throw new AppError(errorCodes.validationError, {
          message: 'Map zone not found.',
        });
      }

      await deleteMapZoneById(app.db, zone.id);
      reply.status(204).send();
    },
  );
};
