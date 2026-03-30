import { Client } from 'pg';
import { env } from '../env.js';

function getAdminUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

async function main() {
  const testUrl = new URL(env.testDatabaseUrl);
  const dbName = testUrl.pathname.replace(/^\//, '');
  const adminClient = new Client({ connectionString: getAdminUrl(env.testDatabaseUrl) });

  await adminClient.connect();

  try {
    await adminClient.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    console.log(`Dropped test database ${dbName} if it existed.`);
  } finally {
    await adminClient.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
