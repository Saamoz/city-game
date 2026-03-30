import { eq, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../db/connection.js';
import { games } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { errorCodes } from '@city-game/shared';

export async function incrementVersion(db: DatabaseClient, gameId: string): Promise<number> {
  const [game] = await db
    .update(games)
    .set({
      stateVersion: sql`${games.stateVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(games.id, gameId))
    .returning({ stateVersion: games.stateVersion });

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }

  return game.stateVersion;
}
