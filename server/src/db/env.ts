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

export const env = {
  databaseUrl: requireEnv('DATABASE_URL'),
  testDatabaseUrl: requireEnv('TEST_DATABASE_URL'),
  adminToken: process.env.ADMIN_TOKEN ?? 'replace-me',
  nodeEnv: getNodeEnv(),
} as const;
