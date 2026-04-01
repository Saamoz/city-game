import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { socketServerEventTypes } from '@city-game/shared';
import { games } from '../db/schema.js';
import { evaluateConfiguredWinConditions } from '../services/win-condition-service.js';

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export interface WinConditionSweepResult {
  endedGames: number;
}

export interface WinConditionJobOptions {
  intervalMs?: number;
  now?: () => Date;
}

export interface WinConditionJobController {
  stop(): void;
  runNow(): Promise<WinConditionSweepResult>;
}

export async function runWinConditionSweep(app: FastifyInstance, now: Date = new Date()): Promise<WinConditionSweepResult> {
  const activeGames = await app.db.select().from(games).where(eq(games.status, 'active'));
  let endedGames = 0;

  for (const game of activeGames) {
    const hasTimeLimit = ((game.winCondition as Array<{ type?: string }> | null) ?? []).some(
      (condition) => condition?.type === 'time_limit',
    );

    if (!hasTimeLimit) {
      continue;
    }

    const result = await evaluateConfiguredWinConditions(app.db, app.modeRegistry, {
      gameId: game.id,
      now,
    });

    if (!result.met || !result.game || result.stateVersion === null) {
      continue;
    }

    endedGames += 1;
    await app.broadcaster.send({
      gameId: game.id,
      modeKey: result.game.modeKey,
      eventType: socketServerEventTypes.gameEnded,
      stateVersion: result.stateVersion,
      payload: {
        game: result.game,
      },
    });
  }

  return { endedGames };
}

export function startWinConditionJob(
  app: FastifyInstance,
  options: WinConditionJobOptions = {},
): WinConditionJobController {
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  let closed = false;
  let inFlight: Promise<WinConditionSweepResult> | null = null;

  const runNow = async () => {
    if (closed) {
      return { endedGames: 0 };
    }

    if (inFlight) {
      return inFlight;
    }

    inFlight = runWinConditionSweep(app, options.now?.()).finally(() => {
      inFlight = null;
    });

    return inFlight;
  };

  const timer = setInterval(() => {
    void runNow();
  }, intervalMs);
  timer.unref?.();

  void runNow();

  const stop = () => {
    if (closed) {
      return;
    }

    closed = true;
    clearInterval(timer);
  };

  app.addHook('onClose', async () => {
    stop();
  });

  return {
    stop,
    runNow,
  };
}
