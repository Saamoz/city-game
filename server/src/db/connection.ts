import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from './env.js';
import { schema } from './schema.js';

export function createPool(connectionString = env.databaseUrl) {
  return new Pool({ connectionString });
}

export function createDb(connectionString = env.databaseUrl) {
  const pool = createPool(connectionString);

  return {
    pool,
    db: drizzle(pool, { schema }),
  };
}
