import type { FastifyInstance } from 'fastify';
import type { GeoJsonPolygon } from '@city-game/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { games, teams, zones } from '../db/schema.js';
import { createTestApp } from '../test/create-test-app.js';
import { createTestGame, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';

const ADMIN_TOKEN = 'test-admin-token';
const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_GAME_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_TEAM_ID = '77777777-7777-4777-8777-777777777777';

describe('zone routes', () => {
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

  it('creates a zone with a computed centroid and returns it from list/detail endpoints', async () => {
    await seedGame();
    await seedTeam();
    app = await createZoneTestApp();

    const createResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/zones`,
      headers: adminHeaders('create-zone-1'),
      payload: {
        name: 'Downtown Square',
        geometry: createSquarePolygon(),
        ownerTeamId: TEAM_ID,
        pointValue: 3,
        claimRadiusMeters: 25,
        metadata: {
          district: 'central',
        },
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const createdZone = createResponse.json().zone;
    expect(createdZone).toMatchObject({
      gameId: GAME_ID,
      ownerTeamId: TEAM_ID,
      pointValue: 3,
      claimRadiusMeters: 25,
      isDisabled: false,
    });
    expect(createdZone.geometry.type).toBe('Polygon');
    expect(createdZone.centroid.type).toBe('Point');

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/zones`,
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().zones).toHaveLength(1);
    expect(listResponse.json().zones[0].id).toBe(createdZone.id);

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/zones/${createdZone.id}`,
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json().zone.id).toBe(createdZone.id);
  });

  it('rejects self-intersecting geometry with the PostGIS reason', async () => {
    await seedGame();
    app = await createZoneTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/zones`,
      headers: adminHeaders('create-zone-invalid-geometry'),
      payload: {
        name: 'Broken Polygon',
        geometry: createSelfIntersectingPolygon(),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(response.json().error.message).toBe('Zone geometry is invalid.');
    expect(response.json().error.details.reason).toEqual(expect.any(String));
  });

  it('bulk imports zones from a FeatureCollection and applies fallback names', async () => {
    await seedGame();
    app = await createZoneTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/zones/import`,
      headers: adminHeaders('import-zones-1'),
      payload: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: createSquarePolygon(-97.1402, 49.8945, 0.0004),
            properties: {
              name: 'Imported One',
              pointValue: 2,
            },
          },
          {
            type: 'Feature',
            geometry: createSquarePolygon(-97.1410, 49.8955, 0.0004),
            properties: {},
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().zones).toHaveLength(2);
    expect(response.json().zones[0].name).toBe('Imported One');
    expect(response.json().zones[1].name).toBe('Imported Zone 2');

    const storedZones = await testDatabase.db.select().from(zones).where(eq(zones.gameId, GAME_ID));
    expect(storedZones).toHaveLength(2);
  });

  it('rejects ownerTeamId values that belong to another game', async () => {
    await seedGame();
    await seedOtherGameWithTeam();
    app = await createZoneTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/zones`,
      headers: adminHeaders('create-zone-invalid-owner'),
      payload: {
        name: 'Cross Game Owner',
        geometry: createSquarePolygon(),
        ownerTeamId: OTHER_TEAM_ID,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'TEAM_NOT_FOUND',
        message: 'Team was not found for this game.',
      },
    });
  });

  it('updates and deletes a zone', async () => {
    await seedGame();
    app = await createZoneTestApp();

    const createResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/zones`,
      headers: adminHeaders('create-zone-for-update'),
      payload: {
        name: 'Mutable Zone',
        geometry: createSquarePolygon(),
      },
    });

    const zoneId = createResponse.json().zone.id as string;

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/zones/${zoneId}`,
      headers: adminHeaders('update-zone-1'),
      payload: {
        name: 'Updated Zone',
        isDisabled: true,
        pointValue: 5,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().zone).toMatchObject({
      id: zoneId,
      name: 'Updated Zone',
      isDisabled: true,
      pointValue: 5,
    });

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/zones/${zoneId}`,
      headers: adminHeaders('delete-zone-1'),
    });

    expect(deleteResponse.statusCode).toBe(204);

    const [storedZone] = await testDatabase.db.select().from(zones).where(eq(zones.id, zoneId)).limit(1);
    expect(storedZone).toBeUndefined();
  });

  async function createZoneTestApp() {
    return createTestApp({
      db: testDatabase.db,
      adminToken: ADMIN_TOKEN,
    });
  }

  async function seedGame() {
    await testDatabase.db.insert(games).values(createTestGame());
  }

  async function seedTeam() {
    await testDatabase.db.insert(teams).values(createTestTeam());
  }

  async function seedOtherGameWithTeam() {
    await testDatabase.db.insert(games).values(
      createTestGame({
        id: OTHER_GAME_ID,
        name: 'Other Game',
      }),
    );

    await testDatabase.db.insert(teams).values(
      createTestTeam({
        id: OTHER_TEAM_ID,
        gameId: OTHER_GAME_ID,
        joinCode: 'OTHER123',
      }),
    );
  }
});

function adminHeaders(idempotencyKey: string) {
  return {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    'idempotency-key': idempotencyKey,
  };
}

function createSquarePolygon(lng = -97.1395, lat = 49.8952, size = 0.0005): GeoJsonPolygon {
  const ring: GeoJsonPolygon['coordinates'][number] = [
    [lng, lat],
    [lng + size, lat],
    [lng + size, lat + size],
    [lng, lat + size],
    [lng, lat],
  ];

  return {
    type: 'Polygon',
    coordinates: [ring],
  };
}

function createSelfIntersectingPolygon(): GeoJsonPolygon {
  const ring: GeoJsonPolygon['coordinates'][number] = [
    [-97.1395, 49.8952],
    [-97.1390, 49.8957],
    [-97.1395, 49.8957],
    [-97.1390, 49.8952],
    [-97.1395, 49.8952],
  ];

  return {
    type: 'Polygon',
    coordinates: [ring],
  };
}
