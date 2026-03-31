import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { games, teams } from '../db/schema.js';
import { createTestApp } from '../test/create-test-app.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { createTestGame } from '../test/factories.js';

const ADMIN_TOKEN = 'test-admin-token';
const GAME_ID = '11111111-1111-4111-8111-111111111111';

describe('game and team routes', () => {
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

  it('creates a game with admin auth and validates winCondition as an array', async () => {
    app = await createGameTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/game',
      headers: adminHeaders('create-game-1'),
      payload: {
        name: 'Downtown Territory',
        modeKey: 'territory',
        city: 'Winnipeg',
        centerLat: 49.8951,
        centerLng: -97.1384,
        defaultZoom: 13,
        winCondition: [{ type: 'all_zones' }],
        settings: { location_tracking_enabled: true },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      game: {
        name: 'Downtown Territory',
        modeKey: 'territory',
        status: 'setup',
        winCondition: [{ type: 'all_zones' }],
      },
    });
  });

  it('rejects game creation without an admin token', async () => {
    app = await createGameTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/game',
      payload: {
        name: 'Unauthorized Game',
        modeKey: 'territory',
        centerLat: 49.8951,
        centerLng: -97.1384,
        defaultZoom: 13,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'ADMIN_REQUIRED',
        message: 'Admin token required.',
      },
    });
  });

  it('rejects winCondition objects that are not arrays', async () => {
    app = await createGameTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/game',
      headers: adminHeaders('create-game-invalid-win-condition'),
      payload: {
        name: 'Invalid Win Condition',
        modeKey: 'territory',
        centerLat: 49.8951,
        centerLng: -97.1384,
        defaultZoom: 13,
        winCondition: { type: 'all_zones' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('gets and updates a game', async () => {
    await seedGame();
    app = await createGameTestApp();

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}`,
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      game: {
        id: GAME_ID,
        name: 'Test Game',
      },
    });

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/game/${GAME_ID}`,
      headers: adminHeaders('update-game-1'),
      payload: {
        name: 'Updated Test Game',
        defaultZoom: 15,
        winCondition: [{ type: 'score_threshold', target: 500 }],
      },
    });

    expect(patchResponse.statusCode).toBe(200);
    expect(patchResponse.json()).toMatchObject({
      game: {
        id: GAME_ID,
        name: 'Updated Test Game',
        defaultZoom: 15,
        winCondition: [{ type: 'score_threshold', target: 500 }],
      },
    });
  });

  it('creates teams with unique auto-generated join codes and lists them', async () => {
    await seedGame();
    app = await createGameTestApp();

    const firstTeamResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/teams`,
      headers: adminHeaders('create-team-1'),
      payload: {
        name: 'Red Team',
        color: '#ff0000',
      },
    });

    const secondTeamResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/teams`,
      headers: adminHeaders('create-team-2'),
      payload: {
        name: 'Blue Team',
        color: '#0000ff',
      },
    });

    expect(firstTeamResponse.statusCode).toBe(201);
    expect(secondTeamResponse.statusCode).toBe(201);

    const firstJoinCode = firstTeamResponse.json().team.joinCode;
    const secondJoinCode = secondTeamResponse.json().team.joinCode;

    expect(firstJoinCode).toHaveLength(8);
    expect(secondJoinCode).toHaveLength(8);
    expect(firstJoinCode).not.toBe(secondJoinCode);

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/teams`,
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().teams).toHaveLength(2);

    const [storedRedTeam, storedBlueTeam] = await testDatabase.db
      .select()
      .from(teams)
      .where(eq(teams.gameId, GAME_ID));

    expect([storedRedTeam?.joinCode, storedBlueTeam?.joinCode]).toContain(firstJoinCode);
    expect([storedRedTeam?.joinCode, storedBlueTeam?.joinCode]).toContain(secondJoinCode);
  });

  it('finds the active game and returns 404 when there is none', async () => {
    await seedGame({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'completed',
    });
    await seedGame({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Active Game',
      status: 'active',
    });

    app = await createGameTestApp();

    const activeResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/game/active',
    });

    expect(activeResponse.statusCode).toBe(200);
    expect(activeResponse.json()).toMatchObject({
      game: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: 'Active Game',
        status: 'active',
      },
    });

    await app.close();
    app = undefined as unknown as FastifyInstance;
    await resetTestDatabase();
    app = await createGameTestApp();

    const missingResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/game/active',
    });

    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json()).toEqual({
      error: {
        code: 'GAME_NOT_FOUND',
        message: 'No active game found.',
      },
    });
  });

  async function createGameTestApp() {
    return createTestApp({
      db: testDatabase.db,
      adminToken: ADMIN_TOKEN,
    });
  }

  async function seedGame(overrides: Record<string, unknown> = {}) {
    const game = createTestGame(overrides);
    await testDatabase.db.insert(games).values(game);

    const [storedGame] = await testDatabase.db
      .select()
      .from(games)
      .where(and(eq(games.id, game.id), eq(games.name, game.name)));

    return storedGame;
  }
});

function adminHeaders(idempotencyKey: string) {
  return {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    'idempotency-key': idempotencyKey,
  };
}
