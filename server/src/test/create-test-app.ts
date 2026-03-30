import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from '../app.js';

export interface CreateTestAppOptions extends BuildAppOptions {
  register?: (app: FastifyInstance) => void | Promise<void>;
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<FastifyInstance> {
  const { register, ...buildOptions } = options;
  const app = buildApp(buildOptions);

  if (register) {
    await register(app);
  }

  await app.ready();
  return app;
}
