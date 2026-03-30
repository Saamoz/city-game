import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeoJsonFeatureCollection, GeoJsonPolygon } from '@city-game/shared';
import type { OsmImportService, OsmPreviewProperties } from '../services/osm-import-service.js';
import { games } from '../db/schema.js';
import { createTestApp } from '../test/create-test-app.js';
import { createTestGame } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';

const ADMIN_TOKEN = 'test-admin-token';
const GAME_ID = '11111111-1111-4111-8111-111111111111';

describe('osm import preview route', () => {
  let app: FastifyInstance;
  let testDatabase: Awaited<ReturnType<typeof getTestDatabase>>;
  let previewAdministrativeBoundaries: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    testDatabase = await getTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    previewAdministrativeBoundaries = vi.fn(async () => createPreviewCollection());
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('returns an OSM preview feature collection for admins', async () => {
    await seedGame();
    app = await createOsmPreviewTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/zones/import-osm`,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      payload: {
        city: 'Chicago',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(createPreviewCollection());
    expect(previewAdministrativeBoundaries).toHaveBeenCalledWith({ city: 'Chicago' });
  });

  it('requires admin auth for OSM preview', async () => {
    await seedGame();
    app = await createOsmPreviewTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/zones/import-osm`,
      payload: {
        city: 'Chicago',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'ADMIN_REQUIRED',
        message: 'Admin token required.',
      },
    });
  });

  it('returns GAME_NOT_FOUND before calling the OSM service', async () => {
    app = await createOsmPreviewTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/zones/import-osm`,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      payload: {
        city: 'Chicago',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'GAME_NOT_FOUND',
        message: 'Game not found.',
      },
    });
    expect(previewAdministrativeBoundaries).not.toHaveBeenCalled();
  });

  async function createOsmPreviewTestApp() {
    const osmImportService: OsmImportService = {
      previewAdministrativeBoundaries,
    };

    return createTestApp({
      db: testDatabase.db,
      adminToken: ADMIN_TOKEN,
      osmImportService,
    });
  }

  async function seedGame() {
    await testDatabase.db.insert(games).values(createTestGame());
  }
});

function createPreviewCollection(): GeoJsonFeatureCollection<GeoJsonPolygon, OsmPreviewProperties> {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'way/101',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-97.1395, 49.8952],
              [-97.139, 49.8952],
              [-97.139, 49.8957],
              [-97.1395, 49.8957],
              [-97.1395, 49.8952],
            ],
          ],
        },
        properties: {
          name: 'Alpha Boundary',
          source: 'osm',
          osmType: 'way',
          osmId: 101,
          adminLevel: '10',
          metadata: {
            source: 'osm',
            sourceCity: 'Chicago',
            osmType: 'way',
            osmId: 101,
            adminLevel: '10',
            tags: {},
          },
        },
      },
    ],
  };
}
