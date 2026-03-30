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
  overpassApiUrl: process.env.OVERPASS_API_URL ?? 'https://overpass-api.de/api/interpreter',
  overpassMinIntervalMs: getOptionalNumber('OVERPASS_MIN_INTERVAL_MS', 1_000),
  overpassTimeoutMs: getOptionalNumber('OVERPASS_TIMEOUT_MS', 15_000),
} as const;
