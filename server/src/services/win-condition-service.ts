import type { Game, WinCondition } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import type { ModeRegistry } from '../modes/index.js';
import { endGameForWinCondition, lockGameById, serializeGameRecord } from './game-service.js';

export interface WinConditionEvaluationOutcome {
  met: boolean;
  winnerTeamId: string | null;
  reason: string | null;
  winCondition: WinCondition | null;
  game: Game | null;
  stateVersion: number | null;
}

export async function evaluateConfiguredWinConditions(
  db: DatabaseClient,
  registry: ModeRegistry,
  input: { gameId: string; now?: Date },
): Promise<WinConditionEvaluationOutcome> {
  return db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as DatabaseClient;
    const game = await lockGameById(transactionalDb, input.gameId);

    if (game.status !== 'active') {
      return unmet();
    }

    const handler = registry.get(game.modeKey);
    const evaluation = await handler.checkWinCondition({
      db: transactionalDb,
      game,
      now: input.now,
    });

    if (!evaluation.hasWinner) {
      return unmet();
    }

    const result = await endGameForWinCondition(transactionalDb, registry, game, {
      winnerTeamId: evaluation.winnerTeamId ?? null,
      reason: evaluation.reason ?? 'win_condition',
      winCondition: evaluation.winCondition ?? null,
      now: input.now,
    });

    return {
      met: true,
      winnerTeamId: evaluation.winnerTeamId ?? null,
      reason: evaluation.reason ?? 'win_condition',
      winCondition: evaluation.winCondition ?? null,
      game: serializeGameRecord(result.game),
      stateVersion: result.stateVersion,
    } satisfies WinConditionEvaluationOutcome;
  });
}

function unmet(): WinConditionEvaluationOutcome {
  return {
    met: false,
    winnerTeamId: null,
    reason: null,
    winCondition: null,
    game: null,
    stateVersion: null,
  };
}
