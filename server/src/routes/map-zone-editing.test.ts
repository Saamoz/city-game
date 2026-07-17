import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { createTestApp } from '../test/create-test-app.js';

describe('map zone boundary editing routes', () => {
  let app: FastifyInstance;
  let testDatabase: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    testDatabase = await getTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    app = await createTestApp({ db: testDatabase.db, pool: testDatabase.pool });
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  async function createMapWithTwoZones(): Promise<{ mapId: string; leftId: string; rightId: string }> {
    const mapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/maps',
      headers: idempotencyHeaders('editing-create-map'),
      payload: { name: 'Editing Map', centerLat: 49.89, centerLng: -97.14, defaultZoom: 12 },
    });
    const mapId = mapResponse.json().map.id as string;

    const leftResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones`,
      headers: idempotencyHeaders('editing-create-left'),
      payload: { name: 'Left', geometry: createRectangle(-97.16, 49.88, -97.14, 49.90) },
    });
    expect(leftResponse.statusCode).toBe(201);

    const rightResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones`,
      headers: idempotencyHeaders('editing-create-right'),
      payload: { name: 'Right', geometry: createRectangle(-97.14, 49.88, -97.12, 49.90) },
    });
    expect(rightResponse.statusCode).toBe(201);

    return {
      mapId,
      leftId: leftResponse.json().zone.id as string,
      rightId: rightResponse.json().zone.id as string,
    };
  }

  it('saves a batch of shared-boundary geometries atomically', async () => {
    const { mapId, leftId, rightId } = await createMapWithTwoZones();

    // Move the shared boundary (-97.14) to -97.135 in both zones, as the
    // client-side boundary editor would after a shared-node drag.
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones/geometries`,
      headers: idempotencyHeaders('editing-bulk-save'),
      payload: {
        updates: [
          { zoneId: leftId, geometry: createRectangle(-97.16, 49.88, -97.135, 49.90) },
          { zoneId: rightId, geometry: createRectangle(-97.135, 49.88, -97.12, 49.90) },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const zones = response.json().zones as Array<{ id: string; geometry: { coordinates: number[][][] } }>;
    expect(zones).toHaveLength(2);
    const left = zones.find((zone) => zone.id === leftId);
    expect(left?.geometry.coordinates[0]).toEqual(expect.arrayContaining([[-97.135, 49.88], [-97.135, 49.90]]));
  });

  it('rejects a batch that would create an overlap, naming the zones', async () => {
    const { mapId, leftId } = await createMapWithTwoZones();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones/geometries`,
      headers: idempotencyHeaders('editing-bulk-overlap'),
      payload: {
        updates: [
          // Left grows over Right without Right shrinking.
          { zoneId: leftId, geometry: createRectangle(-97.16, 49.88, -97.13, 49.90) },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    const error = response.json().error as { message: string };
    expect(error.message).toContain('overlap');
    expect(error.message).toContain('Left');
    expect(error.message).toContain('Right');

    // Nothing was saved.
    const zonesResponse = await app.inject({ method: 'GET', url: `/api/v1/maps/${mapId}/zones` });
    const left = (zonesResponse.json().zones as Array<{ id: string; geometry: { coordinates: number[][][] } }>)
      .find((zone) => zone.id === leftId);
    expect(left?.geometry.coordinates[0]).toEqual(expect.arrayContaining([[-97.14, 49.88]]));
  });

  it('creates a carve zone that takes territory from the zones it overlaps', async () => {
    const { mapId, leftId, rightId } = await createMapWithTwoZones();

    // A new zone straddling the shared boundary, overlapping both.
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones`,
      headers: idempotencyHeaders('editing-carve-create'),
      payload: {
        name: 'Center',
        carve: true,
        geometry: createRectangle(-97.15, 49.885, -97.13, 49.895),
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      zone: { id: string; name: string };
      zones: Array<{ id: string }>;
      trimmedZoneIds: string[];
      creationMode: 'extend' | 'carve';
    };
    expect(body.zone.name).toBe('Center');
    expect(body.creationMode).toBe('carve');
    expect(body.zones).toHaveLength(3);
    expect(body.trimmedZoneIds.sort()).toEqual([leftId, rightId].sort());

    // The map is still a clean partition.
    const statusResponse = await app.inject({ method: 'GET', url: `/api/v1/maps/${mapId}/zones/partition-status` });
    expect(statusResponse.json()).toMatchObject({ isConnected: true, hasNoOverlaps: true });
  });

  it('creates an outer extension whose shared side follows the existing map edge', async () => {
    const { mapId, leftId } = await createMapWithTwoZones();

    // Most of this polygon is outside the map, but it deliberately crosses
    // the west edge. The created zone should keep only the outside portion,
    // using the existing edge at -97.16 as its exact eastern boundary.
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones`,
      headers: idempotencyHeaders('editing-extend-create'),
      payload: {
        name: 'West Extension',
        carve: true,
        geometry: createRectangle(-97.17, 49.885, -97.15, 49.895),
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      zone: { name: string; geometry: { coordinates: number[][][] } };
      zones: Array<{ id: string; geometry: { coordinates: number[][][] } }>;
      trimmedZoneIds: string[];
      creationMode: 'extend' | 'carve';
    };
    expect(body.creationMode).toBe('extend');
    expect(body.trimmedZoneIds).toEqual([]);

    const extensionRing = body.zone.geometry.coordinates[0];
    expect(Math.max(...extensionRing.map(([lng]) => lng))).toBeCloseTo(-97.16, 8);
    expect(extensionRing).toEqual(expect.arrayContaining([[-97.16, 49.885], [-97.16, 49.895]]));

    const unchangedLeft = body.zones.find((zone) => zone.id === leftId);
    expect(unchangedLeft?.geometry.coordinates[0]).toEqual(
      expect.arrayContaining([[-97.16, 49.88], [-97.14, 49.90]]),
    );

    const statusResponse = await app.inject({ method: 'GET', url: `/api/v1/maps/${mapId}/zones/partition-status` });
    expect(statusResponse.json()).toMatchObject({ isConnected: true, hasNoOverlaps: true });
  });

  it('refuses to carve a zone that would swallow an existing zone whole', async () => {
    const { mapId } = await createMapWithTwoZones();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones`,
      headers: idempotencyHeaders('editing-carve-swallow'),
      payload: {
        name: 'Everything',
        carve: true,
        geometry: createRectangle(-97.17, 49.87, -97.11, 49.91),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('completely cover');
  });

  it('still allows edits when the map is already dirty', async () => {
    const { mapId, leftId, rightId } = await createMapWithTwoZones();

    // Force an overlap directly in the database (bypassing the API), the way
    // legacy imported data could be dirty.
    const { sql } = await import('drizzle-orm');
    await testDatabase.db.execute(sql`ALTER TABLE map_zones DISABLE TRIGGER map_zones_connected`);
    await testDatabase.db.execute(sql`
      UPDATE map_zones
      SET geometry = ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(createRectangle(-97.16, 49.88, -97.13, 49.90))}), 4326)
      WHERE id = ${leftId}
    `);
    await testDatabase.db.execute(sql`ALTER TABLE map_zones ENABLE TRIGGER map_zones_connected`);

    const statusBefore = await app.inject({ method: 'GET', url: `/api/v1/maps/${mapId}/zones/partition-status` });
    expect(statusBefore.json().hasNoOverlaps).toBe(false);

    // A geometry save that doesn't fix everything still goes through, because
    // the map was already dirty before the edit.
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/maps/${mapId}/zones/geometries`,
      headers: idempotencyHeaders('editing-dirty-save'),
      payload: {
        updates: [
          { zoneId: rightId, geometry: createRectangle(-97.14, 49.88, -97.115, 49.90) },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
  });
});

function createRectangle(minLng: number, minLat: number, maxLng: number, maxLat: number) {
  return {
    type: 'Polygon' as const,
    coordinates: [[
      [minLng, minLat],
      [maxLng, minLat],
      [maxLng, maxLat],
      [minLng, maxLat],
      [minLng, minLat],
    ]],
  };
}

function idempotencyHeaders(key: string) {
  return {
    'Idempotency-Key': key,
  };
}
