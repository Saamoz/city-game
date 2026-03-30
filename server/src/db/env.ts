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

export const env = {
  databaseUrl: requireEnv('DATABASE_URL'),
  testDatabaseUrl: requireEnv('TEST_DATABASE_URL'),
} as const;
