import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type DatabaseClient, type DatabasePool } from '../db/connection.js';
import { env } from '../db/env.js';

const TRUNCATE_TABLES = [
  'player_location_samples',
  'annotations',
  'action_receipts',
  'game_events',
  'resource_ledger',
  'challenge_claims',
  'challenges',
  'zones',
  'players',
  'teams',
  'games',
  'map_zones',
  'maps',
] as const;

let testDatabase: { db: DatabaseClient; pool: DatabasePool } | null = null;
let migrationsReady = false;

export async function getTestDatabase() {
  if (!testDatabase) {
    testDatabase = createDb(env.testDatabaseUrl);
  }

  if (!migrationsReady) {
    await testDatabase.db.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await testDatabase.db.execute(sql`CREATE EXTENSION IF NOT EXISTS postgis`);
    await migrate(testDatabase.db, { migrationsFolder: 'src/db/migrations' });
    migrationsReady = true;
  }

  return testDatabase;
}

export async function resetTestDatabase() {
  const { db } = await getTestDatabase();
  await db.execute(sql.raw(`TRUNCATE TABLE ${TRUNCATE_TABLES.join(', ')} RESTART IDENTITY CASCADE`));
}

export async function closeTestDatabase() {
  if (!testDatabase) {
    return;
  }

  await testDatabase.pool.end();
  testDatabase = null;
  migrationsReady = false;
}
