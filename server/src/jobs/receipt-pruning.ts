import type { FastifyInstance } from 'fastify';
import { lt } from 'drizzle-orm';
import type { DatabaseClient } from '../db/connection.js';
import { actionReceipts } from '../db/schema.js';

// Receipts only need to outlive client retries of the same action. Location uploads write one
// per player every few seconds, so without pruning the table grows for the life of the server.
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface ReceiptPruningJobOptions {
  intervalMs?: number;
  retentionMs?: number;
  now?: () => Date;
}

export interface ReceiptPruningJobController {
  stop(): void;
  runNow(): Promise<number>;
}

export async function pruneActionReceipts(db: DatabaseClient, olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(actionReceipts)
    .where(lt(actionReceipts.createdAt, olderThan))
    .returning({ id: actionReceipts.id });

  return deleted.length;
}

export function startReceiptPruningJob(
  app: FastifyInstance,
  options: ReceiptPruningJobOptions = {},
): ReceiptPruningJobController {
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  let closed = false;
  let inFlight: Promise<number> | null = null;

  const runNow = async () => {
    if (closed) {
      return 0;
    }

    if (inFlight) {
      return inFlight;
    }

    const now = options.now?.() ?? new Date();
    inFlight = pruneActionReceipts(app.db, new Date(now.getTime() - retentionMs)).finally(() => {
      inFlight = null;
    });

    return inFlight;
  };

  const runSafely = () => {
    void runNow().catch((error) => {
      app.log.error({ err: error }, 'receipt pruning sweep failed');
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
