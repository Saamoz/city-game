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

  it('ties a set to the map of its first pin, keeps its pins on that map and only pairs it with that map', async () => {
    app = await createChallengeSetTestApp(testDatabase);
    const authored = await seedAuthoredMap(app);
    const otherMap = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: idempotencyHeaders('other-map'), payload: { name: 'Other City', centerLat: 49.8951, centerLng: -97.1384, defaultZoom: 12 } });
    const otherMapId = otherMap.json().map.id as string;

    const setResponse = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets', headers: idempotencyHeaders('city-set'), payload: { name: 'City Set', locationMode: 'point' } });
    const challengeSetId = setResponse.json().challengeSet.id as string;
    expect(setResponse.json().challengeSet.mapId).toBeNull();

    const pin = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets/' + challengeSetId + '/items', headers: idempotencyHeaders('city-pin'), payload: { title: 'Pin', description: 'Visit.', mapPoint: { type: 'Point', coordinates: [-79.381, 43.647] }, metadata: { sourceMapId: authored.mapId } } });
    expect(pin.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/api/v1/challenge-sets/' + challengeSetId })).json().challengeSet.mapId).toBe(authored.mapId);

    // A pin without its own map goes on the set's map; one on another map is refused.
    const implicitPin = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets/' + challengeSetId + '/items', headers: idempotencyHeaders('implicit-pin'), payload: { title: 'Implicit', description: 'Visit.', mapPoint: { type: 'Point', coordinates: [-79.382, 43.647] } } });
    expect(implicitPin.statusCode).toBe(201);
    expect(implicitPin.json().item.metadata.sourceMapId).toBe(authored.mapId);
    const offMapPin = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets/' + challengeSetId + '/items', headers: idempotencyHeaders('off-map-pin'), payload: { title: 'Elsewhere', description: 'Visit.', mapPoint: { type: 'Point', coordinates: [-97.13, 49.89] }, metadata: { sourceMapId: otherMapId } } });
    expect(offMapPin.statusCode).toBe(400);

    // The set's map cannot move or be cleared while pins sit on it.
    const moveSet = await app.inject({ method: 'PATCH', url: '/api/v1/challenge-sets/' + challengeSetId, headers: idempotencyHeaders('move-set'), payload: { mapId: otherMapId } });
    expect(moveSet.statusCode).toBe(400);
    const clearSet = await app.inject({ method: 'PATCH', url: '/api/v1/challenge-sets/' + challengeSetId, headers: idempotencyHeaders('clear-set'), payload: { mapId: null } });
    expect(clearSet.statusCode).toBe(400);

    // Games only take a set written for their map; generic sets fit any map.
    const wrongGame = await app.inject({ method: 'POST', url: '/api/v1/game', headers: adminHeaders('wrong-map-game'), payload: { name: 'Wrong', modeKey: 'point_challenge', mapId: otherMapId, challengeSetId } });
    expect(wrongGame.statusCode).toBe(400);
    expect(wrongGame.json().error.message).toContain('City Set');
    const rightGame = await app.inject({ method: 'POST', url: '/api/v1/game', headers: adminHeaders('right-map-game'), payload: { name: 'Right', modeKey: 'point_challenge', mapId: authored.mapId, challengeSetId } });
    expect(rightGame.statusCode).toBe(201);
    const moveGame = await app.inject({ method: 'PATCH', url: '/api/v1/game/' + (rightGame.json().game.id as string), headers: adminHeaders('move-game'), payload: { mapId: otherMapId } });
    expect(moveGame.statusCode).toBe(400);

    const genericSet = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets', headers: idempotencyHeaders('generic-set'), payload: { name: 'Generic', locationMode: 'point' } });
    const genericGame = await app.inject({ method: 'POST', url: '/api/v1/game', headers: adminHeaders('generic-game'), payload: { name: 'Generic', modeKey: 'point_challenge', mapId: otherMapId, challengeSetId: genericSet.json().challengeSet.id } });
    expect(genericGame.statusCode).toBe(201);
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

  it('mixes pinned and anywhere items in a point-linked set: pins go on the map, anywhere items form the deck', async () => {
    app = await createChallengeSetTestApp(testDatabase);
    const authored = await seedAuthoredMap(app);
    const setResponse = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets', headers: idempotencyHeaders('mixed-set'), payload: { name: 'Mixed Trail', locationMode: 'point' } });
    const challengeSetId = setResponse.json().challengeSet.id as string;
    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets/' + challengeSetId + '/items', headers: idempotencyHeaders('mixed-pin-' + index), payload: { title: 'Pin ' + index, description: 'Visit this point.', mapPoint: { type: 'Point', coordinates: [-79.381 + index * 0.001, 43.647] }, sortOrder: index, metadata: { sourceMapId: authored.mapId } } });
      expect(response.statusCode).toBe(201);
    }
    for (let index = 0; index < 4; index += 1) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets/' + challengeSetId + '/items', headers: idempotencyHeaders('mixed-anywhere-' + index), payload: { title: 'Anywhere ' + index, description: 'Do this anywhere.', config: { location_hint: 'Any park' }, sortOrder: 2 + index } });
      expect(response.statusCode).toBe(201);
      expect(response.json().item.config.location_mode).toBe('portable');
    }
    const zoneItemResponse = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets/' + challengeSetId + '/items', headers: idempotencyHeaders('mixed-zone'), payload: { title: 'Zone', description: 'Zone item.', mapZoneId: authored.mapZoneId, metadata: { sourceMapId: authored.mapId } } });
    expect(zoneItemResponse.statusCode).toBe(400);
    const gameResponse = await app.inject({ method: 'POST', url: '/api/v1/game', headers: adminHeaders('mixed-game'), payload: { name: 'Mixed Game', modeKey: 'point_challenge', mapId: authored.mapId, challengeSetId, settings: { active_challenge_count: 2 } } });
    const gameId = gameResponse.json().game.id as string;
    const startResponse = await app.inject({ method: 'POST', url: '/api/v1/game/' + gameId + '/start', headers: adminHeaders('start-mixed-game') });
    expect(startResponse.statusCode).toBe(200);
    const runtimeChallenges = await testDatabase.db.select().from(challenges).where(eq(challenges.gameId, gameId));
    expect(runtimeChallenges).toHaveLength(6);
    const pins = runtimeChallenges.filter((challenge) => (challenge.config as { location_mode?: string }).location_mode === 'point');
    const anywhere = runtimeChallenges.filter((challenge) => (challenge.config as { portable?: boolean }).portable === true);
    expect(pins).toHaveLength(2);
    expect(pins.every((challenge) => challenge.isDeckActive)).toBe(true);
    expect(anywhere).toHaveLength(4);
    expect(anywhere.filter((challenge) => challenge.isDeckActive)).toHaveLength(2);
    expect(anywhere.every((challenge) => (challenge.config as { location_hint?: string }).location_hint === 'Any park')).toBe(true);
  });

  it('caps bonus tasks at three and deals every challenge at start when deal_all_challenges is set', async () => {
    app = await createChallengeSetTestApp(testDatabase);
    const authored = await seedAuthoredMap(app);
    const setResponse = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets', headers: idempotencyHeaders('deal-all-set'), payload: { name: 'Deal All', locationMode: 'point' } });
    const challengeSetId = setResponse.json().challengeSet.id as string;
    const bonus = (id: string) => ({ id, label: 'Bonus ' + id, points: 1 });
    const tooMany = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets/' + challengeSetId + '/items', headers: idempotencyHeaders('too-many-bonuses'), payload: { title: 'Busy', description: 'Too many bonuses.', config: { bonuses: [bonus('a'), bonus('b'), bonus('c'), bonus('d')] } } });
    expect(tooMany.statusCode).toBe(400);
    for (let index = 0; index < 6; index += 1) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets/' + challengeSetId + '/items', headers: idempotencyHeaders('deal-all-item-' + index), payload: { title: 'Anywhere ' + index, description: 'Do it.', config: { bonuses: [bonus('a'), bonus('b'), bonus('c')] }, sortOrder: index } });
      expect(response.statusCode).toBe(201);
    }
    const gameResponse = await app.inject({ method: 'POST', url: '/api/v1/game', headers: adminHeaders('deal-all-game'), payload: { name: 'Deal All Game', modeKey: 'point_challenge', mapId: authored.mapId, challengeSetId, settings: { active_challenge_count: 2, deal_all_challenges: true } } });
    const gameId = gameResponse.json().game.id as string;
    const startResponse = await app.inject({ method: 'POST', url: '/api/v1/game/' + gameId + '/start', headers: adminHeaders('start-deal-all') });
    expect(startResponse.statusCode).toBe(200);
    expect(startResponse.json().game.settings.active_challenge_count).toBe(6);
    const runtimeChallenges = await testDatabase.db.select().from(challenges).where(eq(challenges.gameId, gameId));
    expect(runtimeChallenges.filter((challenge) => challenge.isDeckActive)).toHaveLength(6);
  });

  it('stores drawn challenge areas, rejects self-crossing ones, and deals area challenges at start', async () => {
    app = await createChallengeSetTestApp(testDatabase);
    const authored = await seedAuthoredMap(app);
    const setResponse = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets', headers: idempotencyHeaders('area-set'), payload: { name: 'Areas', locationMode: 'point' } });
    const challengeSetId = setResponse.json().challengeSet.id as string;
    const area = { type: 'Polygon', coordinates: [[[-79.39, 43.64], [-79.38, 43.64], [-79.38, 43.65], [-79.39, 43.65], [-79.39, 43.64]]] };
    const bowtie = { type: 'Polygon', coordinates: [[[-79.39, 43.64], [-79.38, 43.65], [-79.38, 43.64], [-79.39, 43.65], [-79.39, 43.64]]] };
    const created = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets/' + challengeSetId + '/items', headers: idempotencyHeaders('area-item'), payload: { title: 'Park loop', description: 'Anywhere in the park.', config: { area }, metadata: { sourceMapId: authored.mapId } } });
    expect(created.statusCode).toBe(201);
    expect(created.json().item.config.area).toEqual(area);
    const crossing = await app.inject({ method: 'POST', url: '/api/v1/challenge-sets/' + challengeSetId + '/items', headers: idempotencyHeaders('bowtie-item'), payload: { title: 'Bowtie', description: 'Bad shape.', config: { area: bowtie } } });
    expect(crossing.statusCode).toBe(400);
    for (let index = 0; index < 3; index += 1) {
      await app.inject({ method: 'POST', url: '/api/v1/challenge-sets/' + challengeSetId + '/items', headers: idempotencyHeaders('area-deck-' + index), payload: { title: 'Card ' + index, description: 'Anywhere.' } });
    }
    const gameResponse = await app.inject({ method: 'POST', url: '/api/v1/game', headers: adminHeaders('area-game'), payload: { name: 'Area Game', modeKey: 'point_challenge', mapId: authored.mapId, challengeSetId, settings: { active_challenge_count: 1 } } });
    const gameId = gameResponse.json().game.id as string;
    expect((await app.inject({ method: 'POST', url: '/api/v1/game/' + gameId + '/start', headers: adminHeaders('start-area-game') })).statusCode).toBe(200);
    const runtime = await testDatabase.db.select().from(challenges).where(eq(challenges.gameId, gameId));
    const areaChallenge = runtime.find((challenge) => challenge.title === 'Park loop')!;
    expect(areaChallenge.isDeckActive).toBe(true);
    expect(areaChallenge.config).toMatchObject({ portable: false, location_mode: 'area', area });
    expect(runtime.filter((challenge) => challenge.isDeckActive)).toHaveLength(2);
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
