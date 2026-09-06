import { and, eq } from 'drizzle-orm';
import type { DatabaseClient } from '../../db/connection.js';
import { challenges } from '../../db/schema.js';

export async function findNextQueuedChallenge(
  db: DatabaseClient,
  gameId: string,
): Promise<typeof challenges.$inferSelect | null> {
  const [nextQueued] = await db
    .select()
    .from(challenges)
    .where(and(eq(challenges.gameId, gameId), eq(challenges.status, 'available'), eq(challenges.isDeckActive, false)))
    .orderBy(challenges.sortOrder, challenges.createdAt)
    .limit(1)
    .for('update');

  return nextQueued ?? null;
}

export async function activateNextQueuedChallenge(
  db: DatabaseClient,
  gameId: string,
  now: Date,
): Promise<typeof challenges.$inferSelect | null> {
  const nextQueued = await findNextQueuedChallenge(db, gameId);
  if (!nextQueued) return null;

  const [updatedChallenge] = await db
    .update(challenges)
    .set({ isDeckActive: true, updatedAt: now })
    .where(eq(challenges.id, nextQueued.id))
    .returning();

  return updatedChallenge ?? null;
}
