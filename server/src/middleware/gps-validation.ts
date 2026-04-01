import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errorCodes, type GpsPayload } from '@city-game/shared';
import { env } from '../db/env.js';
import { AppError } from '../lib/errors.js';

const MS_PER_SECOND = 1_000;
const SECONDS_PER_HOUR = 3_600;
const METERS_PER_KILOMETER = 1_000;
const EARTH_RADIUS_METERS = 6_371_000;

export const gpsPayloadSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lat', 'lng', 'gpsErrorMeters', 'capturedAt'],
  properties: {
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
    gpsErrorMeters: { type: 'number', minimum: 0 },
    speedMps: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
    headingDegrees: { anyOf: [{ type: 'number', minimum: 0, maximum: 360 }, { type: 'null' }] },
    capturedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export function registerGpsValidation(app: FastifyInstance): void {
  app.decorateRequest('gpsPayload', null);

  app.decorate('validateGps', async (request: FastifyRequest, _reply: FastifyReply) => {
    const gpsPayload = getGpsPayloadFromBody(request.body);

    assertGpsFresh(gpsPayload.capturedAt);
    warnOnImpossibleVelocity(request, gpsPayload);

    request.gpsPayload = gpsPayload;
  });
}

export function warnOnImpossibleVelocity(
  request: Pick<FastifyRequest, 'log' | 'player'>,
  gpsPayload: GpsPayload,
  maxVelocityKmh = env.gpsMaxVelocityKmh,
): void {
  const velocityKmh = calculateVelocityKmh(request.player, gpsPayload);

  if (velocityKmh === null || velocityKmh <= maxVelocityKmh) {
    return;
  }

  request.log.warn(
    {
      playerId: request.player?.id,
      velocityKmh,
      maxVelocityKmh,
      capturedAt: gpsPayload.capturedAt,
    },
    'gps velocity exceeded configured maximum',
  );
}

export function calculateVelocityKmh(
  player: Pick<NonNullable<FastifyRequest['player']>, 'lastLat' | 'lastLng' | 'lastSeenAt'> | null,
  gpsPayload: GpsPayload,
): number | null {
  if (player?.lastLat === null || player?.lastLat === undefined || player.lastLng === null || player.lastLng === undefined || !player.lastSeenAt) {
    return null;
  }

  const previousTimestampMs = new Date(player.lastSeenAt).getTime();
  const currentTimestampMs = new Date(gpsPayload.capturedAt).getTime();
  const elapsedSeconds = (currentTimestampMs - previousTimestampMs) / MS_PER_SECOND;

  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return null;
  }

  const distanceMeters = haversineDistanceMeters(
    Number(player.lastLat),
    Number(player.lastLng),
    gpsPayload.lat,
    gpsPayload.lng,
  );

  return (distanceMeters / METERS_PER_KILOMETER) / (elapsedSeconds / SECONDS_PER_HOUR);
}

function getGpsPayloadFromBody(body: unknown): GpsPayload {
  const payload = extractGpsPayload(body);

  if (!payload) {
    throw new AppError(errorCodes.validationError, {
      message: 'GPS payload is required.',
    });
  }

  return {
    lat: payload.lat,
    lng: payload.lng,
    gpsErrorMeters: payload.gpsErrorMeters,
    speedMps: payload.speedMps ?? null,
    headingDegrees: payload.headingDegrees ?? null,
    capturedAt: payload.capturedAt,
  };
}

type GpsPayloadCandidate = Pick<GpsPayload, 'lat' | 'lng' | 'gpsErrorMeters' | 'capturedAt'> & Partial<Pick<GpsPayload, 'speedMps' | 'headingDegrees'>>;

function extractGpsPayload(value: unknown): GpsPayloadCandidate | null {
  if (isGpsPayloadShape(value)) {
    return value;
  }

  if (value && typeof value === 'object') {
    const nestedGps = (value as Record<string, unknown>).gps ?? (value as Record<string, unknown>).playerLocation;

    if (isGpsPayloadShape(nestedGps)) {
      return nestedGps;
    }
  }

  return null;
}

function isGpsPayloadShape(value: unknown): value is GpsPayloadCandidate {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.lat === 'number' &&
    typeof candidate.lng === 'number' &&
    typeof candidate.gpsErrorMeters === 'number' &&
    typeof candidate.capturedAt === 'string' &&
    ('speedMps' in candidate ? candidate.speedMps === null || typeof candidate.speedMps === 'number' : true) &&
    ('headingDegrees' in candidate
      ? candidate.headingDegrees === null || typeof candidate.headingDegrees === 'number'
      : true)
  );
}

function assertGpsFresh(capturedAt: string): void {
  const capturedAtMs = new Date(capturedAt).getTime();
  const ageMs = Date.now() - capturedAtMs;

  if (!Number.isFinite(capturedAtMs) || ageMs > env.gpsMaxAgeSeconds * MS_PER_SECOND) {
    throw new AppError(errorCodes.gpsTooOld);
  }
}

function haversineDistanceMeters(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const latDeltaRadians = degreesToRadians(toLat - fromLat);
  const lngDeltaRadians = degreesToRadians(toLng - fromLng);
  const fromLatRadians = degreesToRadians(fromLat);
  const toLatRadians = degreesToRadians(toLat);

  const a =
    Math.sin(latDeltaRadians / 2) ** 2 +
    Math.cos(fromLatRadians) * Math.cos(toLatRadians) * Math.sin(lngDeltaRadians / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}
