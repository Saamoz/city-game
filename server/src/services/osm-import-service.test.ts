import { describe, expect, it } from 'vitest';
import { buildOverpassQuery, createOsmImportService } from './osm-import-service.js';

const WAY_PAYLOAD = {
  elements: [
    {
      type: 'way',
      id: 101,
      tags: {
        name: 'Alpha Boundary',
        boundary: 'administrative',
        admin_level: '10',
      },
      geometry: [
        { lat: 49.8952, lon: -97.1395 },
        { lat: 49.8952, lon: -97.1390 },
        { lat: 49.8957, lon: -97.1390 },
        { lat: 49.8957, lon: -97.1395 },
        { lat: 49.8952, lon: -97.1395 },
      ],
    },
  ],
};

describe('osm import service', () => {
  it('falls back from relations to ways and normalizes the preview feature collection', async () => {
    const requests: string[] = [];
    const service = createOsmImportService({
      endpoint: 'https://example.test/overpass',
      fetch: async (_input, init) => {
        requests.push(String(init?.body ?? ''));

        if (requests.length === 1) {
          return new Response(JSON.stringify({ elements: [] }), { status: 200 });
        }

        return new Response(JSON.stringify(WAY_PAYLOAD), { status: 200 });
      },
      minIntervalMs: 0,
    });

    const preview = await service.previewAdministrativeBoundaries({ city: 'Chicago' });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain('relation["boundary"="administrative"]');
    expect(requests[1]).toContain('way["boundary"="administrative"]');
    expect(preview).toEqual({
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
    });
  });

  it('rate limits consecutive preview requests', async () => {
    const sleepCalls: number[] = [];
    let currentTime = 1_000;

    const service = createOsmImportService({
      fetch: async () => new Response(JSON.stringify(WAY_PAYLOAD), { status: 200 }),
      minIntervalMs: 500,
      now: () => currentTime,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        currentTime += ms;
      },
    });

    await service.previewAdministrativeBoundaries({ city: 'Chicago' });
    await service.previewAdministrativeBoundaries({ city: 'Chicago' });

    expect(sleepCalls).toEqual([500]);
  });

  it('builds an Overpass query with escaped city names', () => {
    const query = buildOverpassQuery('St. John"s', 'relation');

    expect(query).toContain('St. John\\"s');
    expect(query).toContain('relation["boundary"="administrative"]');
  });
});
