import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME } from '@city-game/shared';
import { games, players, teams } from '../db/schema.js';
import { createTestApp } from '../test/create-test-app.js';
import { createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';

describe('player routes', () => {
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

  it('registers a player with teamId null and sets a session cookie', async () => {
    await seedGame();
    app = await createPlayerTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/players`,
      payload: {
        display_name: 'New Player',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      player: {
        gameId: GAME_ID,
        teamId: null,
        displayName: 'New Player',
      },
    });
    expect(response.json().player.sessionToken).toBeUndefined();

    const cookieHeader = response.headers['set-cookie'];
    expect(cookieHeader).toEqual(expect.stringContaining(`${SESSION_COOKIE_NAME}=`));
    expect(cookieHeader).toEqual(expect.stringContaining('HttpOnly'));
    expect(cookieHeader).toEqual(expect.stringContaining('SameSite=Strict'));

    const [storedPlayer] = await testDatabase.db.select().from(players).where(eq(players.gameId, GAME_ID));
    expect(storedPlayer?.teamId).toBeNull();
    expect(storedPlayer?.displayName).toBe('New Player');
    expect(storedPlayer?.sessionToken).toBeTruthy();
  });

  it('joins a team and returns the updated player and team', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ teamId: null, sessionToken: 'join-session-token' });
    app = await createPlayerTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/teams/join`,
      cookies: {
        [SESSION_COOKIE_NAME]: 'join-session-token',
      },
      payload: {
        join_code: 'TEAM1234',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      player: {
        id: PLAYER_ID,
        teamId: TEAM_ID,
      },
      team: {
        id: TEAM_ID,
        joinCode: 'TEAM1234',
      },
    });

    const [storedPlayer] = await testDatabase.db
      .select()
      .from(players)
      .where(eq(players.id, PLAYER_ID))
      .limit(1);

    expect(storedPlayer?.teamId).toBe(TEAM_ID);
  });

  it('returns TEAM_NOT_FOUND for an invalid join code', async () => {
    await seedGame();
    await seedPlayer({ teamId: null, sessionToken: 'bad-join-token' });
    app = await createPlayerTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/teams/join`,
      cookies: {
        [SESSION_COOKIE_NAME]: 'bad-join-token',
      },
      payload: {
        join_code: 'NOPE1234',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'TEAM_NOT_FOUND',
        message: 'Team was not found for this game.',
      },
    });
  });

  it('returns 401 when /players/me is called without a session cookie', async () => {
    app = await createPlayerTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/players/me',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
      },
    });
  });

  it('returns the current player from /players/me', async () => {
    await seedGame();
    await seedPlayer({ teamId: null, sessionToken: 'me-session-token' });
    app = await createPlayerTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/players/me',
      cookies: {
        [SESSION_COOKIE_NAME]: 'me-session-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      player: {
        id: PLAYER_ID,
        gameId: GAME_ID,
        teamId: null,
      },
    });
    expect(response.json().player.sessionToken).toBeUndefined();
  });

  async function createPlayerTestApp() {
    return createTestApp({
      db: testDatabase.db,
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

  async function seedTeam(overrides: Record<string, unknown> = {}) {
    const team = createTestTeam(overrides);
    await testDatabase.db.insert(teams).values(team);

    const [storedTeam] = await testDatabase.db
      .select()
      .from(teams)
      .where(eq(teams.id, team.id))
      .limit(1);

    return storedTeam;
  }

  async function seedPlayer(overrides: Record<string, unknown> = {}) {
    const player = createTestPlayer(overrides);
    await testDatabase.db.insert(players).values(player);

    const [storedPlayer] = await testDatabase.db
      .select()
      .from(players)
      .where(eq(players.id, player.id))
      .limit(1);

    return storedPlayer;
  }
});
