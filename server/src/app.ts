import Fastify from 'fastify';
import type { DatabaseClient, DatabasePool } from './db/connection.js';
import { createDb } from './db/connection.js';
import { registerAuth } from './lib/auth.js';
import { registerAppErrorHandler } from './lib/errors.js';
import { createModeRegistry, type ModeRegistry } from './modes/index.js';
import { registerGpsValidation } from './middleware/gps-validation.js';
import { registerIdempotency } from './middleware/idempotency.js';
import { challengeRoutes } from './routes/challenge-routes.js';
import { registerRealtime } from './socket/server.js';
import { eventRoutes } from './routes/event-routes.js';
import { gameRoutes } from './routes/game-routes.js';
import { playerRoutes } from './routes/player-routes.js';
import { resourceRoutes } from './routes/resource-routes.js';
import { stateRoutes } from './routes/state-routes.js';
import { zoneRoutes } from './routes/zone-routes.js';
import { createOsmImportService, type OsmImportService } from './services/osm-import-service.js';
import { createNotificationService, type NotificationService } from './services/notification-service.js';

export interface BuildAppOptions {
  db?: DatabaseClient;
  pool?: DatabasePool;
  adminToken?: string;
  osmImportService?: OsmImportService;
  notificationService?: NotificationService;
  modeRegistry?: ModeRegistry;
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

  const modeRegistry = options.modeRegistry ?? createModeRegistry();

  app.decorate('db', database.db);
  app.decorate('modeRegistry', modeRegistry);
  app.decorate('osmImportService', options.osmImportService ?? createOsmImportService());
  app.decorate('notificationService', options.notificationService ?? createNotificationService());

  if (database.pool && database.ownsPool) {
    app.addHook('onClose', async () => {
      await database.pool?.end();
    });
  }

  registerAppErrorHandler(app);
  registerAuth(app, {
    adminToken: options.adminToken,
  });
  registerIdempotency(app);
  registerGpsValidation(app);
  registerRealtime(app);

  app.get('/health', async () => ({ status: 'ok' }));
  app.register(gameRoutes, { prefix: '/api/v1' });
  app.register(playerRoutes, { prefix: '/api/v1' });
  app.register(resourceRoutes, { prefix: '/api/v1' });
  app.register(stateRoutes, { prefix: '/api/v1' });
  app.register(zoneRoutes, { prefix: '/api/v1' });
  app.register(challengeRoutes, { prefix: '/api/v1' });
  app.register(eventRoutes, { prefix: '/api/v1' });
  app.register(async (modeApp) => {
    modeRegistry.registerRoutes(modeApp);
  }, { prefix: '/api/v1' });

  return app;
}
