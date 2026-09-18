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
        description: 'Point-linked challenges.',
        locationMode: 'point',
      },
    });

    expect(createSetResponse.statusCode).toBe(201);
    expect(createSetResponse.json().challengeSet.locationMode).toBe('point');
    const challengeSetId = createSetResponse.json().challengeSet.id as string;

    const createPortableItem = await app.inject({
      method: 'POST',
      url: '/api/v1/challenge-sets/' + challengeSetId + '/items',
      headers: idempotencyHeaders('create-portable-item'),
      payload: {
        title: 'Photo Pair',
        description: 'Take a matching team photo.',
        mapPoint: { type: 'Point', coordinates: [-79.38, 43.646] },
        metadata: { sourceMapId: authored.mapId },
        sortOrder: 0,
      },
    });

    expect(createPortableItem.statusCode).toBe(201);
    expect(createPortableItem.json().item.mapZoneId).toBeNull();
    expect(createPortableItem.json().item.mapPoint).toMatchObject({ type: 'Point' });
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

  it('clones every item in a point-linked set as an active map challenge without runtime zones', async () => {
    app = await createChallengeSetTestApp(testDatabase);
    const authored = await seedAuthoredMap(app);
    const setResponse = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets', headers: idempotencyHeaders('point-set'), payload: { name: 'Point Trail', locationMode: 'point' } });
    const challengeSetId = setResponse.json().challengeSet.id as string;
    for (let index = 0; index < 4; index += 1) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets/' + challengeSetId + '/items', headers: idempotencyHeaders('point-item-' + index), payload: { title: 'Point ' + index, description: 'Visit this point.', mapPoint: { type: 'Point', coordinates: [-79.381 + index * 0.001, 43.647] }, sortOrder: index, metadata: { sourceMapId: authored.mapId } } });
      expect(response.statusCode).toBe(201);
    }
    const gameResponse = await app.inject({ method: 'POST', url: '/api/v1/game', headers: adminHeaders('point-game'), payload: { name: 'Point Game', modeKey: 'point_challenge', mapId: authored.mapId, challengeSetId } });
    const gameId = gameResponse.json().game.id as string;
    const startResponse = await app.inject({ method: 'POST', url: '/api/v1/game/' + gameId + '/start', headers: adminHeaders('start-point-game') });
    expect(startResponse.statusCode).toBe(200);
    expect(await testDatabase.db.select().from(zones).where(eq(zones.gameId, gameId))).toHaveLength(0);
    const runtimeChallenges = await testDatabase.db.select().from(challenges).where(eq(challenges.gameId, gameId));
    expect(runtimeChallenges).toHaveLength(4);
    expect(runtimeChallenges.every((challenge) => challenge.isDeckActive && challenge.zoneId === null && (challenge.config as { location_mode?: string }).location_mode === 'point')).toBe(true);
  });
});

async function seedAuthoredMap(app: FastifyInstance) {
  const createMapResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/maps',
    headers: idempotencyHeaders('create-authored-map'),
    payload: {
      name: 'Toronto Base Map',
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
