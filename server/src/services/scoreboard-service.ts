import type { ScoreboardEntry } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import type { ModeRegistry } from '../modes/index.js';
import { getGameById } from './game-service.js';

export async function getScoreboard(
  db: DatabaseClient,
  registry: ModeRegistry,
  gameId: string,
): Promise<ScoreboardEntry[]> {
  const game = await getGameById(db, gameId);
  const handler = registry.get(game.modeKey);

  return handler.computeScoreboard({
    db,
    game,
  });
}
