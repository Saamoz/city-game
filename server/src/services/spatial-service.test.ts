import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GeoJsonPolygon } from '@city-game/shared';
import { games } from '../db/schema.js';
import { createTestGame } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import {
  createZone,
  findContainingZones,
  getDistanceToZoneMeters,
  isPointWithinZoneBuffer,
} from './spatial-service.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';

describe('spatial service', () => {
  let testDatabase: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    testDatabase = await getTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await testDatabase.db.insert(games).values(createTestGame());
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('finds containing zones and excludes disabled zones by default', async () => {
    const activeZone = await createZone(testDatabase.db, {
      gameId: GAME_ID,
      name: 'Active Zone',
      geometry: createSquarePolygon(),
    });

    await createZone(testDatabase.db, {
      gameId: GAME_ID,
      name: 'Disabled Zone',
      geometry: createSquarePolygon(),
      isDisabled: true,
    });

    const zones = await findContainingZones(testDatabase.db, {
      gameId: GAME_ID,
      lat: 49.89535,
      lng: -97.13925,
    });

    expect(zones.map((zone) => zone.id)).toEqual([activeZone.id]);
  });

  it('treats points just outside the polygon as inside when the zone buffer covers them', async () => {
    const zone = await createZone(testDatabase.db, {
      gameId: GAME_ID,
      name: 'Buffered Zone',
      geometry: createSquarePolygon(),
      claimRadiusMeters: 35,
    });

    const withinBuffer = await isPointWithinZoneBuffer(testDatabase.db, {
      zoneId: zone.id,
      lat: 49.89535,
      lng: -97.13882,
    });

    expect(withinBuffer).toBe(true);
  });

  it('reports distances in meters for points outside the zone', async () => {
    const zone = await createZone(testDatabase.db, {
      gameId: GAME_ID,
      name: 'Distance Zone',
      geometry: createSquarePolygon(),
    });

    const distanceMeters = await getDistanceToZoneMeters(testDatabase.db, {
      zoneId: zone.id,
      lat: 49.8975,
      lng: -97.1365,
    });

    expect(distanceMeters).toBeGreaterThan(100);
  });
});

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
