import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
        city: 'Toronto',
        centerLat: 43.6532,
        centerLng: -79.3832,
        defaultZoom: 11,
      },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().map).toMatchObject({
      name: 'Toronto Template',
      city: 'Toronto',
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

  it('imports, splits, and merges authored map zones', async () => {
    app = await createTestApp({ db: testDatabase.db, pool: testDatabase.pool });

    const mapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/maps',
      headers: idempotencyHeaders('create-map-for-zones'),
      payload: {
        name: 'Chicago Template',
        city: 'Chicago',
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
        geometry: createSquarePolygon(-87.65, 41.88, 0.01),
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
            geometry: createSquarePolygon(-87.63, 41.88, 0.01),
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
  return {
    type: 'Polygon',
    coordinates: [[
      [centerLng - radius, centerLat - radius],
      [centerLng + radius, centerLat - radius],
      [centerLng + radius, centerLat + radius],
      [centerLng - radius, centerLat + radius],
      [centerLng - radius, centerLat - radius],
    ]],
  };
}
