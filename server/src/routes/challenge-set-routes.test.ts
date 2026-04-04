import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { challenges, zones } from '../db/schema.js';
import { createTestApp } from '../test/create-test-app.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';

const ADMIN_TOKEN = 'test-admin-token';

describe('challenge set routes', () => {
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

  it('creates, updates, and lists reusable challenge sets and items with point placement support', async () => {
    app = await createChallengeSetTestApp(testDatabase);
    const authored = await seedAuthoredMap(app);

    const createSetResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/challenge-sets',
      headers: idempotencyHeaders('create-set'),
      payload: {
        name: 'Transit Deck',
        description: 'Portable + location-linked challenges.',
      },
    });

    expect(createSetResponse.statusCode).toBe(201);
    const challengeSetId = createSetResponse.json().challengeSet.id as string;

    const createPortableItem = await app.inject({
      method: 'POST',
      url: '/api/v1/challenge-sets/' + challengeSetId + '/items',
      headers: idempotencyHeaders('create-portable-item'),
      payload: {
        title: 'Photo Pair',
        description: 'Take a matching team photo.',
        sortOrder: 0,
      },
    });

    expect(createPortableItem.statusCode).toBe(201);
    expect(createPortableItem.json().item.mapZoneId).toBeNull();
    expect(createPortableItem.json().item.mapPoint).toBeNull();
    expect(createPortableItem.json().item.kind).toBe('text');
    expect(createPortableItem.json().item.completionMode).toBe('self_report');

    const createPointItem = await app.inject({
      method: 'POST',
      url: '/api/v1/challenge-sets/' + challengeSetId + '/items',
      headers: idempotencyHeaders('create-point-item'),
      payload: {
        title: 'Station Check-In',
        description: 'Check in at the station plaza.',
        mapPoint: {
          type: 'Point',
          coordinates: [-79.3792, 43.6454],
        },
        sortOrder: 1,
        metadata: { sourceMapId: authored.mapId },
      },
    });

    expect(createPointItem.statusCode).toBe(201);
    expect(createPointItem.json().item.mapPoint).toMatchObject({
      type: 'Point',
      coordinates: [-79.3792, 43.6454],
    });

    const itemId = createPointItem.json().item.id as string;
    const updateItemResponse = await app.inject({
      method: 'PATCH',
      url: '/api/v1/challenge-set-items/' + itemId,
      headers: idempotencyHeaders('update-point-item'),
      payload: {
        title: 'Station Proof',
      },
    });

    expect(updateItemResponse.statusCode).toBe(200);
    expect(updateItemResponse.json().item.title).toBe('Station Proof');

    const listItemsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/challenge-sets/' + challengeSetId + '/items',
    });

    expect(listItemsResponse.statusCode).toBe(200);
    expect(listItemsResponse.json().items).toHaveLength(2);
    expect(listItemsResponse.json().items[1].title).toBe('Station Proof');
  });

  it('clones portable, zone-linked, and point-linked authored items into runtime challenges on game start', async () => {
    app = await createChallengeSetTestApp(testDatabase);
    const authored = await seedAuthoredMap(app);

    const createSetResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/challenge-sets',
      headers: idempotencyHeaders('create-set-for-start'),
      payload: {
        name: 'Territory Deck',
        description: 'Gameplay set',
      },
    });

    const challengeSetId = createSetResponse.json().challengeSet.id as string;

    await app.inject({
      method: 'POST',
      url: '/api/v1/challenge-sets/' + challengeSetId + '/items',
      headers: idempotencyHeaders('create-portable-for-start'),
      payload: {
        title: 'Portable Proof',
        description: 'Portable challenge.',
        sortOrder: 0,
      },
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/challenge-sets/' + challengeSetId + '/items',
      headers: idempotencyHeaders('create-zoned-for-start'),
      payload: {
        title: 'Zone Proof',
        description: 'Linked challenge.',
        mapZoneId: authored.mapZoneId,
        sortOrder: 1,
        metadata: { sourceMapId: authored.mapId },
      },
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/challenge-sets/' + challengeSetId + '/items',
      headers: idempotencyHeaders('create-point-for-start'),
      payload: {
        title: 'Pinned Proof',
        description: 'Point-linked challenge.',
        mapPoint: {
          type: 'Point',
          coordinates: [-79.381, 43.647],
        },
        sortOrder: 2,
        metadata: { sourceMapId: authored.mapId },
      },
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/challenge-sets/' + challengeSetId + '/items',
      headers: idempotencyHeaders('create-fourth-for-start'),
      payload: {
        title: 'Fourth Proof',
        description: 'Queued at start.',
        sortOrder: 3,
      },
    });

    const createGameResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/game',
      headers: adminHeaders('create-game-with-set'),
      payload: {
        name: 'Challenge Clone Game',
        modeKey: 'territory',
        mapId: authored.mapId,
        challengeSetId,
        settings: { active_challenge_count: 2 },
      },
    });

    expect(createGameResponse.statusCode).toBe(201);
    const gameId = createGameResponse.json().game.id as string;

    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/game/' + gameId + '/start',
      headers: adminHeaders('start-game-with-set'),
    });

    expect(startResponse.statusCode).toBe(200);

    const runtimeZones = await testDatabase.db
      .select({ id: zones.id, metadata: zones.metadata })
      .from(zones)
      .where(eq(zones.gameId, gameId));

    expect(runtimeZones).toHaveLength(1);
    expect(runtimeZones[0]?.metadata).toMatchObject({ source_map_zone_id: authored.mapZoneId });

    const runtimeChallenges = await testDatabase.db
      .select({
        id: challenges.id,
        title: challenges.title,
        zoneId: challenges.zoneId,
        sortOrder: challenges.sortOrder,
        isDeckActive: challenges.isDeckActive,
        config: challenges.config,
      })
      .from(challenges)
      .where(eq(challenges.gameId, gameId));

    expect(runtimeChallenges).toHaveLength(4);

    const portable = runtimeChallenges.find((entry) => entry.title === 'Portable Proof');
    const linked = runtimeChallenges.find((entry) => entry.title === 'Zone Proof');
    const pointLinked = runtimeChallenges.find((entry) => entry.title === 'Pinned Proof');
    const queued = runtimeChallenges.find((entry) => entry.title === 'Fourth Proof');

    expect(portable?.zoneId).toBeNull();
    expect(portable?.sortOrder).toBe(0);
    expect(portable?.isDeckActive).toBe(true);
    expect(portable?.config).toMatchObject({
      portable: true,
      location_mode: 'portable',
      source_challenge_set_id: challengeSetId,
    });

    expect(linked?.zoneId).toBe(runtimeZones[0]?.id);
    expect(linked?.sortOrder).toBe(1);
    expect(linked?.isDeckActive).toBe(true);
    expect(linked?.config).toMatchObject({
      portable: false,
      location_mode: 'zone',
      source_map_zone_id: authored.mapZoneId,
    });

    expect(pointLinked?.zoneId).toBeNull();
    expect(pointLinked?.sortOrder).toBe(2);
    expect(pointLinked?.isDeckActive).toBe(false);
    expect(pointLinked?.config).toMatchObject({
      portable: false,
      location_mode: 'point',
      source_map_point: {
        type: 'Point',
        coordinates: [-79.381, 43.647],
      },
    });

    expect(queued?.zoneId).toBeNull();
    expect(queued?.sortOrder).toBe(3);
    expect(queued?.isDeckActive).toBe(false);
  });
});

async function seedAuthoredMap(app: FastifyInstance) {
  const createMapResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/maps',
    headers: idempotencyHeaders('create-authored-map'),
    payload: {
      name: 'Toronto Base Map',
      city: 'Toronto',
      centerLat: 43.6532,
      centerLng: -79.3832,
      defaultZoom: 11,
    },
  });

  const mapId = createMapResponse.json().map.id as string;

  const createZoneResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/maps/' + mapId + '/zones',
    headers: idempotencyHeaders('create-authored-zone'),
    payload: {
      name: 'Union Station Zone',
      geometry: createSquarePolygon(-79.38, 43.65, 0.01),
    },
  });

  return {
    mapId,
    mapZoneId: createZoneResponse.json().zone.id as string,
  };
}

function createChallengeSetTestApp(testDatabase: Awaited<ReturnType<typeof getTestDatabase>>) {
  return createTestApp({
    db: testDatabase.db,
    pool: testDatabase.pool,
    adminToken: ADMIN_TOKEN,
  });
}

function adminHeaders(key: string) {
  return {
    Authorization: 'Bearer ' + ADMIN_TOKEN,
    'Idempotency-Key': key,
  };
}

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

