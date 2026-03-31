import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { env } from '../db/env.js';
import { calculateVelocityKmh, warnOnImpossibleVelocity } from './gps-validation.js';

describe('gps validation middleware', () => {
  it('rejects GPS payloads older than the configured maximum age', async () => {
    const app = buildApp();

    app.post(
      '/gps-check',
      {
        preHandler: [app.validateGps],
        config: {
          skipIdempotency: true,
        },
      },
      async (request, reply) => {
        reply.send({ gps: request.gpsPayload });
      },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/gps-check',
      payload: {
        lat: 49.8951,
        lng: -97.1384,
        gpsErrorMeters: 5,
        capturedAt: new Date(Date.now() - (env.gpsMaxAgeSeconds + 1) * 1_000).toISOString(),
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: 'GPS_TOO_OLD',
        message: 'GPS reading is too old.',
      },
    });

    await app.close();
  });

  it('rejects GPS payloads whose accuracy is outside the configured threshold', async () => {
    const app = buildApp();

    app.post(
      '/gps-check',
      {
        preHandler: [app.validateGps],
        config: {
          skipIdempotency: true,
        },
      },
      async (request, reply) => {
        reply.send({ gps: request.gpsPayload });
      },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/gps-check',
      payload: {
        lat: 49.8951,
        lng: -97.1384,
        gpsErrorMeters: env.gpsMaxErrorMeters + 1,
        capturedAt: new Date().toISOString(),
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: 'GPS_ERROR_TOO_HIGH',
        message: 'GPS accuracy is too low for this action.',
        details: {
          maxErrorMeters: env.gpsMaxErrorMeters,
          gpsErrorMeters: env.gpsMaxErrorMeters + 1,
        },
      },
    });

    await app.close();
  });

  it('attaches a valid GPS payload to the request', async () => {
    const app = buildApp();

    app.post(
      '/gps-check',
      {
        preHandler: [app.validateGps],
        config: {
          skipIdempotency: true,
        },
      },
      async (request, reply) => {
        reply.send({ gps: request.gpsPayload });
      },
    );

    const payload = {
      lat: 49.8951,
      lng: -97.1384,
      gpsErrorMeters: 8,
      speedMps: 1.2,
      headingDegrees: 90,
      capturedAt: new Date().toISOString(),
    };

    const response = await app.inject({
      method: 'POST',
      url: '/gps-check',
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      gps: payload,
    });

    await app.close();
  });

  it('logs impossible velocity without blocking the request flow', () => {
    const now = new Date();
    const warn = vi.fn();

    warnOnImpossibleVelocity(
      {
        log: { warn } as never,
        player: {
          id: 'player-1',
          lastLat: '49.8951',
          lastLng: '-97.1384',
          lastSeenAt: new Date(now.getTime() - 60_000),
        } as never,
      },
      {
        lat: 49.9451,
        lng: -97.1384,
        gpsErrorMeters: 5,
        speedMps: null,
        headingDegrees: null,
        capturedAt: now.toISOString(),
      },
      5,
    );

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('calculates velocity between the previous and current location sample', () => {
    const now = new Date();
    const velocityKmh = calculateVelocityKmh(
      {
        lastLat: '49.8951',
        lastLng: '-97.1384',
        lastSeenAt: new Date(now.getTime() - 60_000),
      },
      {
        lat: 49.9041,
        lng: -97.1384,
        gpsErrorMeters: 5,
        speedMps: null,
        headingDegrees: null,
        capturedAt: now.toISOString(),
      },
    );

    expect(velocityKmh).not.toBeNull();
    expect(velocityKmh!).toBeGreaterThan(0);
  });
});
