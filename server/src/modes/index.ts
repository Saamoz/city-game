import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { errorCodes } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { games } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { createTerritoryModeHandler } from './territory/handler.js';
import type { ModeHandler } from './types.js';

export interface ModeRegistry {
  list(): ModeHandler[];
  get(modeKey: string): ModeHandler;
  registerRoutes(app: FastifyInstance): void;
}

export function createModeRegistry(handlers: ModeHandler[] = [createTerritoryModeHandler()]): ModeRegistry {
  const handlersByModeKey = new Map<string, ModeHandler>();

  for (const handler of handlers) {
    if (handlersByModeKey.has(handler.modeKey)) {
      throw new Error(`Duplicate mode handler registered for ${handler.modeKey}.`);
    }

    handlersByModeKey.set(handler.modeKey, handler);
  }

  return {
    list() {
      return [...handlersByModeKey.values()];
    },
    get(modeKey: string) {
      const handler = handlersByModeKey.get(modeKey);

      if (!handler) {
        throw new AppError(errorCodes.validationError, {
          message: `Unsupported game mode: ${modeKey}.`,
        });
      }

      return handler;
    },
    registerRoutes(app: FastifyInstance) {
      for (const handler of handlersByModeKey.values()) {
        handler.registerRoutes(app);
      }
    },
  };
}

export async function getModeHandlerForGame(
  db: DatabaseClient,
  registry: ModeRegistry,
  gameId: string,
): Promise<ModeHandler> {
  const [game] = await db
    .select({ id: games.id, modeKey: games.modeKey })
    .from(games)
    .where(eq(games.id, gameId))
    .limit(1);

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }

  return registry.get(game.modeKey);
}
