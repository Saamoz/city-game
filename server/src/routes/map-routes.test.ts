import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OsmImportService } from '../services/osm-import-service.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { createTestApp } from '../test/create-test-app.js';

describe('map routes', () => {
  let app: FastifyInstance;
  let testDatabase: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    testDatabase = await getTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('creates and updates a reusable map without admin auth', async () => {
    app = await createTestApp({ db: testDatabase.db, pool: testDatabase.pool });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/maps',
      headers: idempotencyHeaders('create-map-route'),
      payload: {
        name: 'Toronto Template',
        centerLat: 43.6532,
        centerLng: -79.3832,
        defaultZoom: 11,
      },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().map).toMatchObject({
      name: 'Toronto Template',
      centerLat: 43.6532,
      centerLng: -79.3832,
      defaultZoom: 11,
    });

    const mapId = createResponse.json().map.id as string;

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/maps/${mapId}`,
      headers: idempotencyHeaders('update-map-route'),
      payload: {
        name: 'Toronto Template Updated',
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().map.name).toBe('Toronto Template Updated');
  });

  it('uses the saved map name for an OSM preview', async () => {
    const previewAdministrativeBoundaries = vi.fn(async () => ({
      type: 'FeatureCollection' as const,
      features: [],
    }));
    const osmImportService: OsmImportService = { previewAdministrativeBoundaries };
    app = await createTestApp({ db: testDatabase.db, pool: testDatabase.pool, osmImportService });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/maps',
      headers: idempotencyHeaders('create-map-osm-preview'),
      payload: {
        name: 'Toronto',
        centerLat: 43.6532,
        centerLng: -79.3832,
        defaultZoom: 11,
      },
    });
    const mapId = createResponse.json().map.id as string;

    const previewResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones/import-osm`,
      payload: {},
    });

    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.json()).toEqual({ type: 'FeatureCollection', features: [] });
    expect(previewAdministrativeBoundaries).toHaveBeenCalledWith({ placeName: 'Toronto' });
  });

  it('deletes a reusable map and its authored zones', async () => {
    app = await createTestApp({ db: testDatabase.db, pool: testDatabase.pool });

    const createMapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/maps',
      headers: idempotencyHeaders('create-map-delete-route'),
      payload: {
        name: 'Delete Me',
        centerLat: 43.6532,
        centerLng: -79.3832,
        defaultZoom: 11,
      },
    });

    const mapId = createMapResponse.json().map.id as string;

    const createZoneResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones`,
      headers: idempotencyHeaders('create-map-zone-delete-route'),
      payload: {
        name: 'Zone Delete',
        geometry: createSquarePolygon(-79.3832, 43.6532, 0.01),
      },
    });

    expect(createZoneResponse.statusCode).toBe(201);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/maps/${mapId}`,
      headers: idempotencyHeaders('delete-map-route'),
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ deletedMapId: mapId });

    const listMapsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/maps',
    });

    expect(listMapsResponse.json().maps.some((map: { id: string }) => map.id === mapId)).toBe(false);

    const listZonesResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/maps/${mapId}/zones`,
    });

    expect(listZonesResponse.statusCode).toBe(404);
  });

  it('requires authored zones to share boundary edges', async () => {
    app = await createTestApp({ db: testDatabase.db, pool: testDatabase.pool });

    const mapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/maps',
      headers: idempotencyHeaders('create-connected-zone-map'),
      payload: {
        name: 'Connected Zones',
        centerLat: 49.8951,
        centerLng: -97.1384,
        defaultZoom: 12,
      },
    });
    const mapId = mapResponse.json().map.id as string;

    const firstZoneResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones`,
      headers: idempotencyHeaders('create-connected-zone-first'),
      payload: {
        name: 'First',
        geometry: createRectangle(-97.15, 49.88, -97.13, 49.90),
      },
    });
    expect(firstZoneResponse.statusCode).toBe(201);
    const firstZoneId = firstZoneResponse.json().zone.id as string;

    const disconnectedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones`,
      headers: idempotencyHeaders('create-disconnected-zone'),
      payload: {
        name: 'Disconnected',
        geometry: createRectangle(-97.09, 49.88, -97.07, 49.90),
      },
    });
    expect(disconnectedResponse.statusCode).toBe(400);
    expect(disconnectedResponse.json().error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { constraint: 'map_zones_connected' },
    });

    const cornerOnlyResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones`,
      headers: idempotencyHeaders('create-corner-zone'),
      payload: {
        name: 'Corner only',
        geometry: createRectangle(-97.13, 49.90, -97.11, 49.92),
      },
    });
    expect(cornerOnlyResponse.statusCode).toBe(400);

    const overlappingResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones`,
      headers: idempotencyHeaders('create-overlapping-zone'),
      payload: {
        name: 'Overlapping',
        geometry: createRectangle(-97.14, 49.88, -97.12, 49.90),
      },
    });
    expect(overlappingResponse.statusCode).toBe(400);

    const sharedEdgeResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones`,
      headers: idempotencyHeaders('create-shared-edge-zone'),
      payload: {
        name: 'Shared edge',
        geometry: createRectangle(-97.13, 49.88, -97.11, 49.90),
      },
    });
    expect(sharedEdgeResponse.statusCode).toBe(201);

    const synchronizedEditResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/map-zones/${firstZoneId}`,
      headers: idempotencyHeaders('move-shared-zone-edge'),
      payload: {
        geometry: createRectangle(-97.15, 49.88, -97.125, 49.90),
      },
    });
    expect(synchronizedEditResponse.statusCode).toBe(200);
    expect(synchronizedEditResponse.json().zones).toHaveLength(2);
    const synchronizedNeighbor = (synchronizedEditResponse.json().zones as Array<{
      id: string;
      geometry: { coordinates: number[][][] };
    }>).find((zone) => zone.id !== firstZoneId);
    expect(synchronizedNeighbor?.geometry.coordinates[0]).toEqual(expect.arrayContaining([
      [-97.125, 49.88],
      [-97.125, 49.90],
    ]));
  });

  it('prevents deleting a zone that disconnects the remaining map', async () => {
    app = await createTestApp({ db: testDatabase.db, pool: testDatabase.pool });

    const mapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/maps',
      headers: idempotencyHeaders('create-zone-chain-map'),
      payload: {
        name: 'Zone Chain',
        centerLat: 49.8951,
        centerLng: -97.1384,
        defaultZoom: 12,
      },
    });
    const mapId = mapResponse.json().map.id as string;
    const zoneIds: string[] = [];

    const chainBounds = [
      [-97.15, -97.13],
      [-97.13, -97.11],
      [-97.11, -97.09],
    ] as const;
    for (const [index, [minLng, maxLng]] of chainBounds.entries()) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/maps/${mapId}/zones`,
        headers: idempotencyHeaders(`create-zone-chain-${index}`),
        payload: {
          name: `Chain ${index + 1}`,
          geometry: createRectangle(minLng, 49.88, maxLng, 49.90),
        },
      });
      expect(response.statusCode).toBe(201);
      zoneIds.push(response.json().zone.id as string);
    }

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/map-zones/${zoneIds[1]}`,
      headers: idempotencyHeaders('delete-zone-chain-bridge'),
    });

    expect(deleteResponse.statusCode).toBe(400);
    expect(deleteResponse.json().error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { constraint: 'map_zones_connected' },
    });
  });

  it('imports, splits, and merges authored map zones', async () => {
    app = await createTestApp({ db: testDatabase.db, pool: testDatabase.pool });

    const mapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/maps',
      headers: idempotencyHeaders('create-map-for-zones'),
      payload: {
        name: 'Chicago Template',
        centerLat: 41.8781,
        centerLng: -87.6298,
        defaultZoom: 11,
      },
    });

    const mapId = mapResponse.json().map.id as string;

    const createZoneResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones`,
      headers: idempotencyHeaders('create-map-zone-a'),
      payload: {
        name: 'Zone A',
        geometry: createRectangle(-87.66, 41.87, -87.64, 41.89),
      },
    });

    expect(createZoneResponse.statusCode).toBe(201);
    const zoneAId = createZoneResponse.json().zone.id as string;

    const importResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones/import`,
      headers: idempotencyHeaders('import-map-zone-b'),
      payload: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: createRectangle(-87.64, 41.87, -87.62, 41.89),
            properties: {
              name: 'Zone B',
            },
          },
        ],
      },
    });

    expect(importResponse.statusCode).toBe(201);
    expect(importResponse.json().zones).toHaveLength(1);

    const splitResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/map-zones/${zoneAId}/split`,
      headers: idempotencyHeaders('split-map-zone-a'),
    });

    expect(splitResponse.statusCode).toBe(200);
    expect(splitResponse.json().zones).toHaveLength(2);

    const listAfterSplit = await app.inject({
      method: 'GET',
      url: `/api/v1/maps/${mapId}/zones`,
    });

    expect(listAfterSplit.statusCode).toBe(200);
    expect(listAfterSplit.json().zones).toHaveLength(3);

    const splitZoneIds = (listAfterSplit.json().zones as Array<{ id: string; name: string }>)
      .filter((zone) => zone.name.startsWith('Zone A'))
      .map((zone) => zone.id);

    expect(splitZoneIds).toHaveLength(2);

    const mergeResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/map-zones/merge',
      headers: idempotencyHeaders('merge-map-zone-a'),
      payload: {
        zoneIds: splitZoneIds,
        name: 'Zone A Restored',
      },
    });

    expect(mergeResponse.statusCode).toBe(200);
    expect(mergeResponse.json().zone.name).toBe('Zone A Restored');

    const listAfterMerge = await app.inject({
      method: 'GET',
      url: `/api/v1/maps/${mapId}/zones`,
    });

    expect(listAfterMerge.statusCode).toBe(200);
    expect(listAfterMerge.json().zones).toHaveLength(2);
    expect(listAfterMerge.json().zones.some((zone: { name: string }) => zone.name === 'Zone A Restored')).toBe(true);
  });
});

function idempotencyHeaders(key: string) {
  return {
    'Idempotency-Key': key,
  };
}

function createSquarePolygon(centerLng: number, centerLat: number, radius: number) {
  return createRectangle(
    centerLng - radius,
    centerLat - radius,
    centerLng + radius,
    centerLat + radius,
  );
}

function createRectangle(minLng: number, minLat: number, maxLng: number, maxLat: number) {
  return {
    type: 'Polygon',
    coordinates: [[
      [minLng, minLat],
      [maxLng, minLat],
      [maxLng, maxLat],
      [minLng, maxLat],
      [minLng, minLat],
    ]],
  };
}
