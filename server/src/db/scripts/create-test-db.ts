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
    const exists = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);

    if (!exists.rowCount) {
      await adminClient.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created test database ${dbName}.`);
    } else {
      console.log(`Test database ${dbName} already exists.`);
    }
  } finally {
    await adminClient.end();
  }

  const testClient = new Client({ connectionString: env.testDatabaseUrl });
  await testClient.connect();

  try {
    await testClient.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await testClient.query('CREATE EXTENSION IF NOT EXISTS postgis');
    console.log('Ensured pgcrypto and postgis extensions exist in the test database.');
  } finally {
    await testClient.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
