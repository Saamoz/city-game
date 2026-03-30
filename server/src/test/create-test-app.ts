import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';

export async function createTestApp(
  register?: (app: FastifyInstance) => void | Promise<void>,
): Promise<FastifyInstance> {
  const app = buildApp();

  if (register) {
    await register(app);
  }

  await app.ready();
  return app;
}
