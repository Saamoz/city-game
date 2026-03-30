import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { games, players, resourceLedger, teams } from '../db/schema.js';
import { createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import {
  getAllBalances,
  getBalance,
  getHistory,
  getTeamBalances,
  seedInitialBalances,
  transact,
} from './resource-service.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM_ID = '77777777-7777-4777-8777-777777777777';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';

describe('resource service', () => {
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

  it('reads balances and history after sequential transactions', async () => {
    await seedGameTeamAndPlayer();
    await seedOtherTeam();

    const firstEntry = await transact(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_ID,
      resourceType: 'points',
      delta: 10,
      reason: 'challenge_complete',
    });

    const secondEntry = await transact(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_ID,
      resourceType: 'points',
      delta: 5,
      reason: 'bonus',
    });

    await transact(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_ID,
      resourceType: 'coins',
      delta: 3,
      reason: 'challenge_complete',
    });

    expect(firstEntry.sequence).toBe(1);
    expect(secondEntry.sequence).toBe(2);
    expect(secondEntry.balanceAfter).toBe(15);

    await expect(
      getBalance(testDatabase.db, {
        gameId: GAME_ID,
        teamId: TEAM_ID,
        resourceType: 'points',
      }),
    ).resolves.toBe(15);

    await expect(
      getTeamBalances(testDatabase.db, {
        gameId: GAME_ID,
        teamId: TEAM_ID,
      }),
    ).resolves.toEqual({
      points: 15,
      coins: 3,
    });

    await expect(getAllBalances(testDatabase.db, GAME_ID)).resolves.toEqual({
      [TEAM_ID]: { points: 15, coins: 3 },
      [OTHER_TEAM_ID]: { points: 0, coins: 0 },
    });

    const history = await getHistory(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_ID,
      resourceType: 'points',
    });

    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.sequence)).toEqual([2, 1]);
    expect(history[0]).toMatchObject({
      resourceType: 'points',
      balanceAfter: 15,
      reason: 'bonus',
    });
  });

  it('rejects transactions that would make a balance negative', async () => {
    await seedGameTeamAndPlayer();

    await expect(
      transact(testDatabase.db, {
        gameId: GAME_ID,
        teamId: TEAM_ID,
        resourceType: 'coins',
        delta: -1,
        reason: 'spend',
      }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_RESOURCES',
      statusCode: 422,
    });
  });

  it('serializes concurrent writes into correct sequences', async () => {
    await seedGameTeamAndPlayer();

    const entries = await Promise.all(
      Array.from({ length: 5 }, () =>
        transact(testDatabase.db, {
          gameId: GAME_ID,
          teamId: TEAM_ID,
          resourceType: 'points',
          delta: 1,
          reason: 'parallel_award',
        }),
      ),
    );

    const sortedSequences = entries.map((entry) => entry.sequence).sort((left, right) => left - right);
    expect(sortedSequences).toEqual([1, 2, 3, 4, 5]);

    const history = await getHistory(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_ID,
      resourceType: 'points',
      limit: 10,
    });

    expect(history).toHaveLength(5);
    expect(history[0].balanceAfter).toBe(5);

    await expect(
      getBalance(testDatabase.db, {
        gameId: GAME_ID,
        teamId: TEAM_ID,
        resourceType: 'points',
      }),
    ).resolves.toBe(5);
  });

  it('seeds initial balances for all teams', async () => {
    await seedGameTeamAndPlayer();
    await seedOtherTeam();

    const entries = await seedInitialBalances(testDatabase.db, {
      gameId: GAME_ID,
      teamIds: [TEAM_ID, OTHER_TEAM_ID],
      balances: {
        points: 100,
        coins: 5,
      },
    });

    expect(entries).toHaveLength(4);
    await expect(getAllBalances(testDatabase.db, GAME_ID)).resolves.toEqual({
      [TEAM_ID]: { points: 100, coins: 5 },
      [OTHER_TEAM_ID]: { points: 100, coins: 5 },
    });
  });

  it('enforces the unique sequence index at the database level', async () => {
    await seedGameTeamAndPlayer();

    await testDatabase.db.insert(resourceLedger).values({
      gameId: GAME_ID,
      teamId: TEAM_ID,
      playerId: null,
      resourceType: 'points',
      delta: 10,
      balanceAfter: 10,
      sequence: 1,
      reason: 'seed',
      referenceId: null,
      referenceType: null,
    });

    await expect(
      testDatabase.db.insert(resourceLedger).values({
        gameId: GAME_ID,
        teamId: TEAM_ID,
        playerId: null,
        resourceType: 'points',
        delta: 5,
        balanceAfter: 15,
        sequence: 1,
        reason: 'duplicate',
        referenceId: null,
        referenceType: null,
      }),
    ).rejects.toMatchObject({
      cause: {
        code: '23505',
      },
    });
  });

  async function seedGameTeamAndPlayer() {
    await testDatabase.db.insert(games).values(createTestGame());
    await testDatabase.db.insert(teams).values(createTestTeam());
    await testDatabase.db.insert(players).values(createTestPlayer({ id: PLAYER_ID }));
  }

  async function seedOtherTeam() {
    await testDatabase.db.insert(teams).values(
      createTestTeam({
        id: OTHER_TEAM_ID,
        name: 'Other Team',
        color: '#2563eb',
        joinCode: 'TEAM5678',
      }),
    );
  }
});
