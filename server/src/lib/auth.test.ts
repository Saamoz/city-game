import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME } from '@city-game/shared';
import { teams, players, games } from '../db/schema.js';
import { createTestApp } from '../test/create-test-app.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { setSessionCookie } from './auth.js';

const ADMIN_TOKEN = 'test-admin-token';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';

describe('auth middleware', () => {
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

  it('returns 401 when the session cookie is missing', async () => {
    app = await createAuthTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/test/authenticated',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
      },
    });
  });

  it('attaches the player for a valid session cookie', async () => {
    const sessionToken = 'session-valid-player';
    await seedPlayer({ sessionToken });

    app = await createAuthTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/test/authenticated',
      cookies: {
        [SESSION_COOKIE_NAME]: sessionToken,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      playerId: PLAYER_ID,
      teamId: TEAM_ID,
    });
  });

  it('returns 403 NOT_ON_TEAM when a route requires team membership', async () => {
    const sessionToken = 'session-no-team';
    await seedPlayer({
      sessionToken,
      teamId: null,
    });

    app = await createAuthTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/test/team-required',
      cookies: {
        [SESSION_COOKIE_NAME]: sessionToken,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_ON_TEAM',
        message: 'Player must join a team first.',
      },
    });
  });

  it('returns 403 when the admin bearer token is missing', async () => {
    app = await createAuthTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/test/admin-required',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'ADMIN_REQUIRED',
        message: 'Admin token required.',
      },
    });
  });

  it('sets an httpOnly session cookie with strict same-site policy', async () => {
    app = await createAuthTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/test/set-cookie',
      headers: {
        'idempotency-key': 'set-cookie-test',
      },
    });

    expect(response.statusCode).toBe(200);
    const cookieHeader = response.headers['set-cookie'];

    expect(cookieHeader).toEqual(
      expect.stringContaining(`${SESSION_COOKIE_NAME}=session-cookie-token`),
    );
    expect(cookieHeader).toEqual(expect.stringContaining('HttpOnly'));
    expect(cookieHeader).toEqual(expect.stringContaining('SameSite=Strict'));
  });

  it('accepts a valid admin bearer token', async () => {
    app = await createAuthTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/test/admin-required',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  async function createAuthTestApp() {
    return createTestApp({
      db: testDatabase.db,
      adminToken: ADMIN_TOKEN,
      register(instance) {
        instance.get('/test/authenticated', { preHandler: [instance.authenticate] }, async (request) => ({
          playerId: request.player?.id,
          teamId: request.player?.teamId ?? null,
        }));

        instance.get('/test/team-required', { preHandler: [instance.requireTeam] }, async (request) => ({
          teamId: request.player?.teamId,
        }));

        instance.get('/test/admin-required', { preHandler: [instance.requireAdmin] }, async () => ({
          ok: true,
        }));

        instance.post('/test/set-cookie', async (_request, reply) => {
          setSessionCookie(reply, 'session-cookie-token');
          return { ok: true };
        });
      },
    });
  }

  async function seedPlayer(overrides: Record<string, unknown> = {}) {
    const game = createTestGame();
    await testDatabase.db.insert(games).values(game);

    const player = createTestPlayer(overrides);

    if (player.teamId) {
      const team = createTestTeam({ id: player.teamId, gameId: game.id });
      await testDatabase.db.insert(teams).values(team);
    }

    await testDatabase.db.insert(players).values(player);

    const [insertedPlayer] = await testDatabase.db
      .select()
      .from(players)
      .where(eq(players.id, player.id))
      .limit(1);

    return insertedPlayer;
  }
});
