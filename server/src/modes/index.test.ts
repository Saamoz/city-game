import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME } from '@city-game/shared';
import { games, players, resourceLedger, teams } from '../db/schema.js';
import { createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { createTestApp } from '../test/create-test-app.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { getAllBalances, getHistory } from '../services/resource-service.js';
import { createModeRegistry, getModeHandlerForGame } from './index.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM_ID = '77777777-7777-4777-8777-777777777777';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';
const CHALLENGE_ID = '55555555-5555-4555-8555-555555555555';

describe('mode registry', () => {
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

  it('loads the territory handler and exposes its resource definitions', () => {
    const registry = createModeRegistry();
    const handler = registry.get('territory');

    expect(handler.modeKey).toBe('territory');
    expect(handler.getInitialResources()).toEqual([
      {
        type: 'points',
        label: 'Points',
        scope: 'team',
        description: 'Primary scoring resource for Territory win conditions and standings.',
        initialBalance: 0,
      },
      {
        type: 'coins',
        label: 'Coins',
        scope: 'team',
        description: 'Secondary team currency reserved for future Territory mechanics.',
        initialBalance: 0,
      },
    ]);
  });

  it('throws a validation error for unknown modes', async () => {
    const registry = createModeRegistry();
    await testDatabase.db.insert(games).values(createTestGame({ id: GAME_ID, modeKey: 'mystery_mode' }));

    await expect(getModeHandlerForGame(testDatabase.db, registry, GAME_ID)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      message: 'Unsupported game mode: mystery_mode.',
    });
  });

  it('initializes territory resources on game start', async () => {
    const registry = createModeRegistry();
    await testDatabase.db.insert(games).values(createTestGame());
    await testDatabase.db.insert(teams).values(createTestTeam());
    await testDatabase.db.insert(teams).values(
      createTestTeam({
        id: OTHER_TEAM_ID,
        name: 'Blue Team',
        color: '#2563eb',
        joinCode: 'BLUE1234',
      }),
    );

    const [game] = await testDatabase.db.select().from(games).where(eq(games.id, GAME_ID)).limit(1);
    const handler = registry.get('territory');

    await handler.onGameStart({
      db: testDatabase.db,
      game,
    });

    expect(await getAllBalances(testDatabase.db, GAME_ID)).toEqual({
      [TEAM_ID]: { points: 0, coins: 0 },
      [OTHER_TEAM_ID]: { points: 0, coins: 0 },
    });

    expect(
      await getHistory(testDatabase.db, {
        gameId: GAME_ID,
        teamId: TEAM_ID,
        limit: 10,
      }),
    ).toHaveLength(2);

    const zeroRows = await testDatabase.db.select().from(resourceLedger).where(eq(resourceLedger.gameId, GAME_ID));
    expect(zeroRows).toHaveLength(4);
    expect(zeroRows.every((row) => row.delta === 0 && row.balanceAfter === 0 && row.reason === 'game_start_seed')).toBe(true);
  });

  it('registers the territory skeleton routes during app startup', async () => {
    await testDatabase.db.insert(games).values(createTestGame());
    await testDatabase.db.insert(teams).values(createTestTeam());
    await testDatabase.db.insert(players).values(createTestPlayer({ id: PLAYER_ID, sessionToken: 'territory-route-token' }));
    app = await createTestApp({ db: testDatabase.db });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${CHALLENGE_ID}/claim`,
      cookies: {
        [SESSION_COOKIE_NAME]: 'territory-route-token',
      },
      headers: {
        'idempotency-key': 'territory-claim-skeleton',
      },
      payload: {
        lat: 49.8951,
        lng: -97.1384,
        gpsErrorMeters: 5,
        capturedAt: new Date().toISOString(),
      },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Territory mode action endpoints are not implemented yet.',
      },
    });
  });
});
