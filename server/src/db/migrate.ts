import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './connection.js';

async function main() {
  const { db, pool } = createDb();

  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS postgis`);
    await migrate(db, { migrationsFolder: 'src/db/migrations' });
    console.log('Database migration complete.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
