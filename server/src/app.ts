import Fastify from 'fastify';
import type { DatabaseClient, DatabasePool } from './db/connection.js';
import { createDb } from './db/connection.js';
import { registerAuth } from './lib/auth.js';
import { registerAppErrorHandler } from './lib/errors.js';

export interface BuildAppOptions {
  db?: DatabaseClient;
  pool?: DatabasePool;
  adminToken?: string;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: false,
  });

  const database = options.db
    ? { db: options.db, pool: options.pool, ownsPool: false }
    : {
        ...createDb(),
        ownsPool: true,
      };

  app.decorate('db', database.db);

  if (database.pool && database.ownsPool) {
    app.addHook('onClose', async () => {
      await database.pool?.end();
    });
  }

  registerAppErrorHandler(app);
  registerAuth(app, {
    adminToken: options.adminToken,
  });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
