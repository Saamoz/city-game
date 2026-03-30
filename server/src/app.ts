import Fastify from 'fastify';
import { registerAppErrorHandler } from './lib/errors.js';

export function buildApp() {
  const app = Fastify({
    logger: false,
  });

  registerAppErrorHandler(app);

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
