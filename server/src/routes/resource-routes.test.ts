import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../test/create-test-app.js';
import { createTestGame, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { transact } from '../services/resource-service.js';
import { games, teams } from '../db/schema.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_GAME_ID = '66666666-6666-4666-8666-666666666666';
const OUTSIDE_TEAM_ID = '99999999-9999-4999-8999-999999999999';

describe('resource routes', () => {
  let app: FastifyInstance;
  let testDatabase: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    testDatabase = await getTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('returns all team balances with zero defaults', async () => {
    await seedGame();
    await seedTeam();
    await seedOtherTeam();
    await transact(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_ID,
      resourceType: 'points',
      delta: 25,
      reason: 'seed',
    });
    await transact(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_ID,
      resourceType: 'coins',
      delta: 4,
      reason: 'seed',
    });

    app = await createResourceTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/resources`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      resources: {
        [TEAM_ID]: { points: 25, coins: 4 },
        [OTHER_TEAM_ID]: { points: 0, coins: 0 },
      },
    });
  });

  it('returns a single team balance snapshot and filtered history', async () => {
    await seedGame();
    await seedTeam();
    await transact(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_ID,
      resourceType: 'points',
      delta: 10,
      reason: 'challenge_complete',
    });
    await transact(testDatabase.db, {
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
      delta: 2,
      reason: 'challenge_complete',
    });

    app = await createResourceTestApp();

    const balanceResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/resources/${TEAM_ID}`,
    });

    expect(balanceResponse.statusCode).toBe(200);
    expect(balanceResponse.json()).toEqual({
      teamId: TEAM_ID,
      resources: { points: 15, coins: 2 },
    });

    const historyResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/resources/${TEAM_ID}/history?resourceType=points&limit=2`,
    });

    expect(historyResponse.statusCode).toBe(200);
    expect(historyResponse.json().history).toHaveLength(2);
    expect(historyResponse.json().history[0]).toMatchObject({
      resourceType: 'points',
      balanceAfter: 15,
      reason: 'bonus',
      sequence: 2,
    });
  });

  it('rejects teams that are not in the requested game', async () => {
    await seedGame();
    await seedTeam();
    await seedOtherGameAndTeam();
    app = await createResourceTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/resources/${OUTSIDE_TEAM_ID}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'TEAM_NOT_FOUND',
        message: 'Team was not found for this game.',
      },
    });
  });

  async function createResourceTestApp() {
    return createTestApp({
      db: testDatabase.db,
    });
  }

  async function seedGame() {
    await testDatabase.db.insert(games).values(createTestGame());
  }

  async function seedTeam() {
    await testDatabase.db.insert(teams).values(createTestTeam());
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

  async function seedOtherGameAndTeam() {
    await testDatabase.db.insert(games).values(
      createTestGame({
        id: OTHER_GAME_ID,
        name: 'Other Game',
      }),
    );
    await testDatabase.db.insert(teams).values(
      createTestTeam({
        id: OUTSIDE_TEAM_ID,
        gameId: OTHER_GAME_ID,
        name: 'Outside Team',
        color: '#16a34a',
        joinCode: 'TEAM9999',
      }),
    );
  }
});
