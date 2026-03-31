import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { buildIdempotencyContext, findStoredReceipt, replayStoredReceipt } from '../services/idempotency-service.js';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE']);

export function registerIdempotency(app: FastifyInstance): void {
  app.decorateRequest('idempotency', null);

  app.decorate('requireIdempotency', async (request: FastifyRequest, reply: FastifyReply) => {
    const context = buildIdempotencyContext(app, request);
    const receipt = await findStoredReceipt(app.db, context);

    if (receipt) {
      replayStoredReceipt(reply, receipt);
      request.idempotency = null;
      return;
    }

    request.idempotency = context;
  });

  app.addHook('onRoute', (routeOptions: RouteOptions) => {
    const methods = normalizeMethods(routeOptions.method);
    const config = (routeOptions.config ?? {}) as { skipIdempotency?: boolean };

    if (!methods.some((method) => MUTATING_METHODS.has(method)) || config.skipIdempotency) {
      return;
    }

    const existingPreHandlers = normalizePreHandlers(routeOptions.preHandler);
    routeOptions.preHandler = [...existingPreHandlers, app.requireIdempotency];
  });
}

function normalizeMethods(method: RouteOptions['method']): string[] {
  if (Array.isArray(method)) {
    return method.map((value) => value.toUpperCase());
  }

  return [method.toUpperCase()];
}

function normalizePreHandlers(preHandler: RouteOptions['preHandler']) {
  if (!preHandler) {
    return [];
  }

  return Array.isArray(preHandler) ? [...preHandler] : [preHandler];
}