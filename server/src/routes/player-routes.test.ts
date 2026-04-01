import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME } from '@city-game/shared';
import { env } from '../db/env.js';
import { games, playerLocationSamples, players, teams } from '../db/schema.js';
import { createTestApp } from '../test/create-test-app.js';
import { createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';

const DEFAULT_LOCATION_RETENTION_HOURS = 24;

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

  it('requires Idempotency-Key for player registration', async () => {
    await seedGame();
    app = await createPlayerTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/players`,
      payload: {
        display_name: 'Missing Key',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Idempotency-Key header required.',
      },
    });
  });

  it('replays a registration response without creating a second player', async () => {
    await seedGame();
    app = await createPlayerTestApp();

    const firstResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/players`,
      headers: idempotencyHeaders('register-player-replay'),
      payload: {
        display_name: 'Replay Player',
      },
    });

    const secondResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/players`,
      headers: idempotencyHeaders('register-player-replay'),
      payload: {
        display_name: 'Replay Player',
      },
    });

    expect(firstResponse.statusCode).toBe(201);
    expect(secondResponse.statusCode).toBe(201);
    expect(secondResponse.json()).toEqual(firstResponse.json());
    expect(secondResponse.headers['set-cookie']).toBe(firstResponse.headers['set-cookie']);

    const storedPlayers = await testDatabase.db.select().from(players).where(eq(players.gameId, GAME_ID));
    expect(storedPlayers).toHaveLength(1);
    expect(storedPlayers[0]?.displayName).toBe('Replay Player');
  });

  it('returns IDEMPOTENCY_CONFLICT when a registration key is reused with a different body', async () => {
    await seedGame();
    app = await createPlayerTestApp();

    const firstResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/players`,
      headers: idempotencyHeaders('register-player-conflict'),
      payload: {
        display_name: 'Player One',
      },
    });

    const secondResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/players`,
      headers: idempotencyHeaders('register-player-conflict'),
      payload: {
        display_name: 'Player Two',
      },
    });

    expect(firstResponse.statusCode).toBe(201);
    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json()).toEqual({
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency key was reused with a different request.',
      },
    });
  });

  it('registers a player with teamId null and sets a session cookie', async () => {
    await seedGame();
    app = await createPlayerTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/players`,
      headers: idempotencyHeaders('register-player-cookie'),
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
      headers: idempotencyHeaders('join-team-success'),
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
      headers: idempotencyHeaders('join-team-invalid-code'),
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


  it('stores a web push subscription for the current player', async () => {
    await seedGame();
    await seedPlayer({ teamId: null, sessionToken: 'push-subscribe-token' });
    app = await createPlayerTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/players/me/push-subscribe',
      headers: idempotencyHeaders('player-push-subscribe'),
      cookies: {
        [SESSION_COOKIE_NAME]: 'push-subscribe-token',
      },
      payload: {
        endpoint: 'https://push.example/subscriptions/abc',
        expirationTime: null,
        keys: {
          p256dh: 'p256dh-key',
          auth: 'auth-key',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      player: {
        id: PLAYER_ID,
        pushSubscription: {
          endpoint: 'https://push.example/subscriptions/abc',
          expirationTime: null,
          keys: {
            p256dh: 'p256dh-key',
            auth: 'auth-key',
          },
        },
      },
    });

    const [storedPlayer] = await testDatabase.db
      .select({ pushSubscription: players.pushSubscription })
      .from(players)
      .where(eq(players.id, PLAYER_ID))
      .limit(1);

    expect(storedPlayer?.pushSubscription).toEqual({
      endpoint: 'https://push.example/subscriptions/abc',
      expirationTime: null,
      keys: {
        p256dh: 'p256dh-key',
        auth: 'auth-key',
      },
    });
  });

  it('updates the current player location without storing a sample when tracking is disabled', async () => {
    await seedGame();
    await seedPlayer({ teamId: null, sessionToken: 'location-session-token' });
    app = await createPlayerTestApp();

    const capturedAt = new Date().toISOString();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/players/me/location',
      headers: idempotencyHeaders('player-location-success'),
      cookies: {
        [SESSION_COOKIE_NAME]: 'location-session-token',
      },
      payload: {
        lat: 49.8951,
        lng: -97.1384,
        gpsErrorMeters: 7,
        capturedAt,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      player: {
        id: PLAYER_ID,
        lastLat: '49.8951000',
        lastLng: '-97.1384000',
        lastGpsError: 7,
        lastSeenAt: capturedAt,
      },
      gps: {
        lat: 49.8951,
        lng: -97.1384,
        gpsErrorMeters: 7,
        speedMps: null,
        headingDegrees: null,
        capturedAt,
      },
      tracking: {
        enabled: false,
        sampleStored: false,
        retentionHours: DEFAULT_LOCATION_RETENTION_HOURS,
      },
    });

    const [storedPlayer] = await testDatabase.db
      .select()
      .from(players)
      .where(eq(players.id, PLAYER_ID))
      .limit(1);

    expect(storedPlayer?.lastLat).toBe('49.8951000');
    expect(storedPlayer?.lastLng).toBe('-97.1384000');
    expect(storedPlayer?.lastGpsError).toBe(7);
    expect(storedPlayer?.lastSeenAt?.toISOString()).toBe(capturedAt);

    const storedSamples = await testDatabase.db.select().from(playerLocationSamples).where(eq(playerLocationSamples.playerId, PLAYER_ID));
    expect(storedSamples).toHaveLength(0);
  });

  it('stores a location sample when tracking is enabled for the game', async () => {
    await seedGame({
      settings: {
        location_tracking_enabled: true,
        location_retention_hours: 12,
      },
    });
    await seedPlayer({ teamId: null, sessionToken: 'tracked-location-token' });
    app = await createPlayerTestApp();

    const capturedAt = new Date().toISOString();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/players/me/location',
      headers: idempotencyHeaders('player-location-tracked'),
      cookies: {
        [SESSION_COOKIE_NAME]: 'tracked-location-token',
      },
      payload: {
        lat: 49.8951,
        lng: -97.1384,
        gpsErrorMeters: 5,
        speedMps: 2.5,
        headingDegrees: 90,
        capturedAt,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tracking: {
        enabled: true,
        sampleStored: true,
        retentionHours: 12,
      },
    });

    const [storedSample] = await testDatabase.db
      .select({
        gameId: playerLocationSamples.gameId,
        playerId: playerLocationSamples.playerId,
        recordedAt: playerLocationSamples.recordedAt,
        gpsErrorMeters: playerLocationSamples.gpsErrorMeters,
        speedMps: playerLocationSamples.speedMps,
        headingDegrees: playerLocationSamples.headingDegrees,
        source: playerLocationSamples.source,
      })
      .from(playerLocationSamples)
      .where(eq(playerLocationSamples.playerId, PLAYER_ID))
      .limit(1);

    expect(storedSample).toMatchObject({
      gameId: GAME_ID,
      playerId: PLAYER_ID,
      gpsErrorMeters: 5,
      speedMps: 2.5,
      headingDegrees: 90,
      source: 'browser',
    });
    expect(storedSample?.recordedAt.toISOString()).toBe(capturedAt);
  });

  it('replays a tracked location update without inserting a duplicate sample', async () => {
    await seedGame({
      settings: {
        location_tracking_enabled: true,
        location_retention_hours: 6,
      },
    });
    await seedPlayer({ teamId: null, sessionToken: 'location-replay-token' });
    app = await createPlayerTestApp();

    const payload = {
      lat: 49.8951,
      lng: -97.1384,
      gpsErrorMeters: 4,
      capturedAt: new Date().toISOString(),
    };

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/players/me/location',
      headers: idempotencyHeaders('player-location-replay'),
      cookies: {
        [SESSION_COOKIE_NAME]: 'location-replay-token',
      },
      payload,
    });

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/players/me/location',
      headers: idempotencyHeaders('player-location-replay'),
      cookies: {
        [SESSION_COOKIE_NAME]: 'location-replay-token',
      },
      payload,
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual(firstResponse.json());

    const storedSamples = await testDatabase.db.select().from(playerLocationSamples).where(eq(playerLocationSamples.playerId, PLAYER_ID));
    expect(storedSamples).toHaveLength(1);
  });

  it('returns GPS_TOO_OLD when /players/me/location is called with stale GPS', async () => {
    await seedGame();
    await seedPlayer({ teamId: null, sessionToken: 'stale-location-token' });
    app = await createPlayerTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/players/me/location',
      headers: idempotencyHeaders('player-location-stale'),
      cookies: {
        [SESSION_COOKIE_NAME]: 'stale-location-token',
      },
      payload: {
        lat: 49.8951,
        lng: -97.1384,
        gpsErrorMeters: 7,
        capturedAt: new Date(Date.now() - (env.gpsMaxAgeSeconds + 1) * 1_000).toISOString(),
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: 'GPS_TOO_OLD',
        message: 'GPS reading is too old.',
      },
    });
  });

  it('returns GPS_ERROR_TOO_HIGH when /players/me/location exceeds the max error radius', async () => {
    await seedGame();
    await seedPlayer({ teamId: null, sessionToken: 'bad-accuracy-token' });
    app = await createPlayerTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/players/me/location',
      headers: idempotencyHeaders('player-location-error'),
      cookies: {
        [SESSION_COOKIE_NAME]: 'bad-accuracy-token',
      },
      payload: {
        lat: 49.8951,
        lng: -97.1384,
        gpsErrorMeters: env.gpsMaxErrorMeters + 1,
        capturedAt: new Date().toISOString(),
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: 'GPS_ERROR_TOO_HIGH',
        message: 'GPS accuracy is too low for this action.',
        details: {
          maxErrorMeters: env.gpsMaxErrorMeters,
          gpsErrorMeters: env.gpsMaxErrorMeters + 1,
        },
      },
    });
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

    const [storedTeam] = await testDatabase.db.select().from(teams).where(eq(teams.id, team.id)).limit(1);

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

function idempotencyHeaders(idempotencyKey: string) {
  return {
    'idempotency-key': idempotencyKey,
  };
}
