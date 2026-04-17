import type { FastifyInstance } from 'fastify';
import { cleanupPlayerLocationSamples, type CleanupPlayerLocationSamplesResult } from '../services/player-location-service.js';

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;

export interface PlayerLocationCleanupJobOptions {
  intervalMs?: number;
  now?: () => Date;
}

export interface PlayerLocationCleanupJobController {
  stop(): void;
  runNow(): Promise<CleanupPlayerLocationSamplesResult>;
}

export async function runPlayerLocationCleanup(
  app: FastifyInstance,
  now: Date = new Date(),
): Promise<CleanupPlayerLocationSamplesResult> {
  return cleanupPlayerLocationSamples(app.db, now);
}

export function startPlayerLocationCleanupJob(
  app: FastifyInstance,
  options: PlayerLocationCleanupJobOptions = {},
): PlayerLocationCleanupJobController {
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  let closed = false;
  let inFlight: Promise<CleanupPlayerLocationSamplesResult> | null = null;

  const runNow = async () => {
    if (closed) {
      return { deletedSamples: 0 };
    }

    if (inFlight) {
      return inFlight;
    }

    inFlight = runPlayerLocationCleanup(app, options.now?.()).finally(() => {
      inFlight = null;
    });

    return inFlight;
  };

  const runSafely = () => {
    void runNow().catch((error) => {
      app.log.error({ err: error }, 'player-location cleanup failed');
    });
  };

  const timer = setInterval(() => {
    runSafely();
  }, intervalMs);
  timer.unref?.();

  runSafely();

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
