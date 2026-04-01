import {
  DEFAULT_CLAIM_TIMEOUT_MINUTES,
  DEFAULT_GPS_MAX_AGE_SECONDS,
  DEFAULT_GPS_MAX_ERROR_METERS,
  DEFAULT_GPS_MAX_VELOCITY_KMH,
} from '@city-game/shared';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '..', '.env') });
config({ path: resolve(process.cwd(), '.env') });

function requireEnv(name: 'DATABASE_URL' | 'TEST_DATABASE_URL') {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function getNodeEnv() {
  const value = process.env.NODE_ENV;

  if (value === 'production' || value === 'test') {
    return value;
  }

  return 'development';
}

function getOptionalNumber(name: string, fallback: number) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) ? parsedValue : fallback;
}

export const env = {
  databaseUrl: requireEnv('DATABASE_URL'),
  testDatabaseUrl: requireEnv('TEST_DATABASE_URL'),
  adminToken: process.env.ADMIN_TOKEN ?? 'replace-me',
  nodeEnv: getNodeEnv(),
  claimTimeoutMinutes: getOptionalNumber('CLAIM_TIMEOUT_MINUTES', DEFAULT_CLAIM_TIMEOUT_MINUTES),
  gpsMaxErrorMeters: getOptionalNumber('GPS_MAX_ERROR_METERS', DEFAULT_GPS_MAX_ERROR_METERS),
  gpsMaxAgeSeconds: getOptionalNumber('GPS_MAX_AGE_SECONDS', DEFAULT_GPS_MAX_AGE_SECONDS),
  gpsMaxVelocityKmh: getOptionalNumber('GPS_MAX_VELOCITY_KMH', DEFAULT_GPS_MAX_VELOCITY_KMH),
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? null,
  vapidSubject: process.env.VAPID_SUBJECT ?? null,
  pushRateLimitMs: getOptionalNumber('PUSH_RATE_LIMIT_MS', 60_000),
  overpassApiUrl: process.env.OVERPASS_API_URL ?? 'https://overpass-api.de/api/interpreter',
  overpassMinIntervalMs: getOptionalNumber('OVERPASS_MIN_INTERVAL_MS', 1_000),
  overpassTimeoutMs: getOptionalNumber('OVERPASS_TIMEOUT_MS', 15_000),
} as const;
