import { describe, expect, it } from 'vitest';
import type { GameEventRecord, GeoJsonPoint } from '@city-game/shared';
import { cleanLocationPath, findCompletionLocation, parseEwkbPoint, type RawLocationPoint } from './game-recap-service.js';

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

describe('challenge completion stamps', () => {
  const completion = (meta: Record<string, unknown>) => ({ id: 'event-1', eventType: 'CHALLENGE_COMPLETED', actorTeamId: 'team-1', meta, createdAt: '2026-01-01T12:30:00.000Z' }) as unknown as GameEventRecord;
  const paths = [{ teamId: 'team-1', points: [
    { lng: -87.7, lat: 41.9, recordedAt: '2026-01-01T12:00:00.000Z', progress: 0.2 },
    { lng: -87.6, lat: 42.0, recordedAt: '2026-01-01T13:00:00.000Z', progress: 0.6 },
  ] }];

  it('reads the PostGIS hex point stored on the claim', () => {
    expect(parseEwkbPoint('0101000020e6100000f853e3a59be855c08638d6c56df44440')).toEqual({ lng: -87.6345, lat: 41.9096 });
    expect(findCompletionLocation(completion({ claim: { locationAtClaim: '0101000020e6100000f853e3a59be855c08638d6c56df44440' } }), paths, 0.4)).toEqual({ lng: -87.6345, lat: 41.9096 });
  });

  it("falls back to the challenge's pin, then its area, then the team's trail", () => {
    expect(findCompletionLocation(completion({ claim: { locationAtClaim: null }, challenge: { config: { map_point: { type: 'Point', coordinates: [-87.63, 41.93] } } } }), paths, 0.4)).toEqual({ lng: -87.63, lat: 41.93 });
    const area = { type: 'Polygon', coordinates: [[[-87.66, 41.91], [-87.64, 41.91], [-87.64, 41.93], [-87.66, 41.93]]] };
    const fromArea = findCompletionLocation(completion({ challenge: { config: { area } } }), paths, 0.4);
    expect(fromArea?.lng).toBeCloseTo(-87.65);
    expect(fromArea?.lat).toBeCloseTo(41.92);
    const fromTrail = findCompletionLocation(completion({ challenge: { config: {} } }), paths, 0.4);
    expect(fromTrail?.lng).toBeCloseTo(-87.65);
    expect(fromTrail?.lat).toBeCloseTo(41.95);
    expect(findCompletionLocation(completion({}), paths, 0.1)).toBeNull();
  });
});
