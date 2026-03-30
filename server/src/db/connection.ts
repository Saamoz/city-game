import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from './env.js';
import { schema } from './schema.js';

function createDrizzle(pool: Pool) {
  return drizzle(pool, { schema });
}

export type DatabaseClient = ReturnType<typeof createDrizzle>;
export type DatabasePool = Pool;

export function createPool(connectionString = env.databaseUrl) {
  return new Pool({ connectionString });
}

export function createDb(connectionString = env.databaseUrl) {
  const pool = createPool(connectionString);

  return {
    pool,
    db: createDrizzle(pool),
  };
}
