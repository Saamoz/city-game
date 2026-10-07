import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actionReceipts, games } from '../db/schema.js';
import { createTestGame } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { pruneActionReceipts } from './receipt-pruning.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';

describe('receipt pruning job', () => {
  let testDatabase: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    testDatabase = await getTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('deletes receipts older than the cutoff and keeps newer ones', async () => {
    await testDatabase.db.insert(games).values(createTestGame({ id: GAME_ID }));
    const now = new Date('2026-10-07T12:00:00.000Z');
    await testDatabase.db.insert(actionReceipts).values([
      receipt('old-action', new Date(now.getTime() - 25 * 60 * 60 * 1000)),
      receipt('recent-action', new Date(now.getTime() - 60 * 60 * 1000)),
    ]);

    const deleted = await pruneActionReceipts(testDatabase.db, new Date(now.getTime() - 24 * 60 * 60 * 1000));

    expect(deleted).toBe(1);
    const remaining = await testDatabase.db.select({ actionId: actionReceipts.actionId }).from(actionReceipts);
    expect(remaining).toEqual([{ actionId: 'recent-action' }]);
  });
});

function receipt(actionId: string, createdAt: Date) {
  return {
    gameId: GAME_ID,
    playerId: null,
    scopeKey: 'public',
    actionType: 'test_action',
    actionId,
    requestHash: 'hash',
    response: { ok: true },
    responseHeaders: {},
    statusCode: 200,
    createdAt,
  };
}
