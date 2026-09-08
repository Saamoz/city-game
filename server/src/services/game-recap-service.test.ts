import { describe, expect, it } from 'vitest';
import type { GeoJsonPoint } from '@city-game/shared';
import { cleanLocationPath, type RawLocationPoint } from './game-recap-service.js';

function point(seconds: number, lng: number, lat = 49.9, gpsErrorMeters: number | null = 12): RawLocationPoint {
  return {
    teamId: 'team-1',
    recordedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)),
    location: { type: 'Point', coordinates: [lng, lat] } satisfies GeoJsonPoint,
    gpsErrorMeters,
  };
}

describe('cleanLocationPath', () => {
  it('removes an isolated impossible GPS spike', () => {
    const cleaned = cleanLocationPath([
      point(0, -97.14),
      point(15, -96.2),
      point(30, -97.139),
    ]);
    expect(cleaned.map((entry) => entry.location.coordinates[0])).toEqual([-97.14, -97.139]);
  });

  it('preserves a large jump after a long signal gap', () => {
    const cleaned = cleanLocationPath([
      point(0, -97.14),
      point(15, -97.139),
      point(180, -97.02),
    ]);
    expect(cleaned).toHaveLength(3);
  });

  it('drops fixes with very poor reported accuracy', () => {
    const cleaned = cleanLocationPath([
      point(0, -97.14),
      point(15, -97.139, 49.9, 350),
      point(30, -97.138),
    ]);
    expect(cleaned).toHaveLength(2);
  });
});
