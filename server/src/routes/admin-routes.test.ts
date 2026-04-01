import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  SESSION_COOKIE_NAME,
  STATE_VERSION_HEADER,
  eventTypes,
  socketClientEventTypes,
  socketServerEventTypes,
} from '@city-game/shared';
import { challengeClaims, challenges, gameEvents, games, players, resourceLedger, teams, zones } from '../db/schema.js';
import { createZone } from '../services/spatial-service.js';
import { createTestApp } from '../test/create-test-app.js';
import { createSocketClient, connectSocketClient } from '../test/socket-client-factory.js';
import { createTestChallenge, createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';

const ADMIN_TOKEN = 'test-admin-token';
const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ONE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_TWO_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const PLAYER_ONE_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_TWO_ID = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';
const CHALLENGE_ID = '55555555-5555-4555-8555-555555555555';
const CLAIM_ID = '77777777-7777-4777-8777-777777777777';
const ZONE_ID = '44444444-4444-4444-8444-444444444444';

const ZONE_GEOMETRY = {
  type: 'Polygon',
  coordinates: [[
    [-97.1405, 49.8944],
    [-97.1363, 49.8944],
    [-97.1363, 49.8962],
    [-97.1405, 49.8962],
    [-97.1405, 49.8944],
  ]],
} as unknown as import('@city-game/shared').GeoJsonPolygon;

describe('admin override routes', () => {
  let app: FastifyInstance;
  let baseUrl = '';
  let testDatabase: Awaited<ReturnType<typeof getTestDatabase>>;
  const sockets: ReturnType<typeof createSocketClient>[] = [];

  beforeAll(async () => {
    testDatabase = await getTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    sockets.length = 0;
    baseUrl = '';
  });

  afterEach(async () => {
    for (const socket of sockets) {
      socket.removeAllListeners();
      socket.disconnect();
      socket.close();
    }

    await app?.close();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('requires admin auth for override endpoints', async () => {
    await seedGame();
    app = await createAdminTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/game/${GAME_ID}/rebroadcast-state`,
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'ADMIN_REQUIRED',
        message: 'Admin token required.',
      },
    });
  });

  it('force-completes a claimed challenge and logs an admin override event', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer();
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id, scoring: { points: 15 } });
    await seedClaimedChallenge({ expiresAt: new Date(Date.now() + 5 * 60_000) });
    app = await createAdminTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/challenges/${CHALLENGE_ID}/force-complete`,
      headers: adminHeaders('admin-force-complete'),
      payload: {
        submission: { note: 'admin-finish' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers[STATE_VERSION_HEADER.toLowerCase()]).toEqual(expect.any(String));
    expect(response.json()).toMatchObject({
      challenge: { id: CHALLENGE_ID, status: 'completed' },
      claim: { id: CLAIM_ID, status: 'completed' },
      zone: { id: zone.id, ownerTeamId: TEAM_ONE_ID },
      resourcesAwarded: { points: 15 },
    });

    const [storedChallenge] = await testDatabase.db.select().from(challenges).where(eq(challenges.id, CHALLENGE_ID));
    const [storedZone] = await testDatabase.db.select().from(zones).where(eq(zones.id, zone.id));
    expect(storedChallenge?.status).toBe('completed');
    expect(storedZone?.ownerTeamId).toBe(TEAM_ONE_ID);

    const ledgerRows = await testDatabase.db.select().from(resourceLedger).where(eq(resourceLedger.gameId, GAME_ID));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.delta).toBe(15);

    const overrideEvents = await adminOverrideEvents();
    expect(overrideEvents).toHaveLength(1);
    expect(overrideEvents[0]).toMatchObject({
      eventType: eventTypes.adminOverride,
      actorType: 'admin',
      entityType: 'challenge',
    });
  });

  it('resets a challenge back to available and releases the current claim', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer();
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    await seedClaimedChallenge({ expiresAt: new Date(Date.now() + 5 * 60_000) });
    app = await createAdminTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/challenges/${CHALLENGE_ID}/reset`,
      headers: adminHeaders('admin-reset'),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      challenge: { id: CHALLENGE_ID, status: 'available', currentClaimId: null },
      claim: { id: CLAIM_ID, status: 'released' },
    });

    const [storedChallenge] = await testDatabase.db.select().from(challenges).where(eq(challenges.id, CHALLENGE_ID));
    const [storedClaim] = await testDatabase.db.select().from(challengeClaims).where(eq(challengeClaims.id, CLAIM_ID));
    expect(storedChallenge?.status).toBe('available');
    expect(storedClaim?.status).toBe('released');

    const overrideEvents = await adminOverrideEvents();
    expect(overrideEvents[0]).toMatchObject({ actorType: 'admin', entityType: 'challenge' });
  });

  it('assigns a zone owner and logs admin control changes', async () => {
    await seedGame();
    await seedTeam();
    await seedTeam({ id: TEAM_TWO_ID, name: 'Blue Team', color: '#2563eb', joinCode: 'BLUE1234' });
    await seedPlayer();
    const zone = await seedZone();
    app = await createAdminTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/zones/${zone.id}/assign-owner`,
      headers: adminHeaders('admin-assign-owner'),
      payload: {
        teamId: TEAM_TWO_ID,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      zone: { id: zone.id, ownerTeamId: TEAM_TWO_ID },
    });

    const [storedZone] = await testDatabase.db.select().from(zones).where(eq(zones.id, zone.id));
    expect(storedZone?.ownerTeamId).toBe(TEAM_TWO_ID);

    const overrideEvents = await adminOverrideEvents();
    expect(overrideEvents[0]).toMatchObject({ actorType: 'admin', entityType: 'zone' });
  });

  it('moves a player to another team and logs the admin override', async () => {
    await seedGame();
    await seedTeam();
    await seedTeam({ id: TEAM_TWO_ID, name: 'Blue Team', color: '#2563eb', joinCode: 'BLUE1234' });
    await seedPlayer();
    app = await createAdminTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/players/${PLAYER_ONE_ID}/move-team`,
      headers: adminHeaders('admin-move-team'),
      payload: {
        teamId: TEAM_TWO_ID,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      player: { id: PLAYER_ONE_ID, teamId: TEAM_TWO_ID },
    });

    const [storedPlayer] = await testDatabase.db.select().from(players).where(eq(players.id, PLAYER_ONE_ID));
    expect(storedPlayer?.teamId).toBe(TEAM_TWO_ID);

    const overrideEvents = await adminOverrideEvents();
    expect(overrideEvents[0]).toMatchObject({ actorType: 'admin', entityType: 'player' });
  });

  it('rebroadcasts authoritative state to connected sockets and logs admin override', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'rebroadcast-session' });
    app = await createAdminTestApp();
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

    const socket = trackSocket(createSocketClient({
      url: baseUrl,
      cookie: sessionCookie('rebroadcast-session'),
    }));
    await connectSocketClient(socket);
    await socket.timeout(1000).emitWithAck(socketClientEventTypes.joinGame, { gameId: GAME_ID });

    const syncPromise = waitForSocketEvent(socket, socketServerEventTypes.gameStateSync);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/game/${GAME_ID}/rebroadcast-state`,
      headers: adminHeaders('admin-rebroadcast'),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const syncEvent = await syncPromise;
    expect(syncEvent).toMatchObject({
      gameId: GAME_ID,
      snapshot: {
        game: { id: GAME_ID },
        player: { id: PLAYER_ONE_ID },
      },
    });

    const overrideEvents = await adminOverrideEvents();
    expect(overrideEvents[0]).toMatchObject({ actorType: 'admin', entityType: 'game' });
  });

  it('adjusts resources and logs both resource and admin override events', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer();
    app = await createAdminTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/resources/adjust',
      headers: adminHeaders('admin-adjust-resources'),
      payload: {
        gameId: GAME_ID,
        teamId: TEAM_ONE_ID,
        resourceType: 'points',
        delta: -5,
        reason: 'manual_debug',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      entry: {
        teamId: TEAM_ONE_ID,
        resourceType: 'points',
        delta: -5,
        balanceAfter: -5,
      },
    });

    const [entry] = await testDatabase.db.select().from(resourceLedger).where(eq(resourceLedger.gameId, GAME_ID));
    expect(entry?.delta).toBe(-5);
    expect(entry?.balanceAfter).toBe(-5);

    const overrideEvents = await adminOverrideEvents();
    expect(overrideEvents[0]).toMatchObject({ actorType: 'admin', entityType: 'resource_ledger' });
  });

  async function adminOverrideEvents() {
    return testDatabase.db
      .select({ eventType: gameEvents.eventType, actorType: gameEvents.actorType, entityType: gameEvents.entityType })
      .from(gameEvents)
      .where(eq(gameEvents.eventType, eventTypes.adminOverride))
      .orderBy(asc(gameEvents.createdAt));
  }

  async function createAdminTestApp() {
    return createTestApp({
      db: testDatabase.db,
      adminToken: ADMIN_TOKEN,
    });
  }

  function trackSocket(socket: ReturnType<typeof createSocketClient>) {
    sockets.push(socket);
    return socket;
  }

  async function seedGame(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(games).values(createTestGame({ status: 'active', ...overrides }));
  }

  async function seedTeam(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(teams).values(createTestTeam(overrides));
  }

  async function seedPlayer(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(players).values(createTestPlayer({ id: PLAYER_ONE_ID, ...overrides }));
  }

  async function seedZone(overrides: Record<string, unknown> = {}) {
    return createZone(testDatabase.db, {
      gameId: GAME_ID,
      name: 'Downtown Zone',
      geometry: ZONE_GEOMETRY,
      pointValue: 1,
      ...(overrides as { ownerTeamId?: string | null }),
    });
  }

  async function seedChallenge(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(challenges).values(createTestChallenge({
      id: CHALLENGE_ID,
      gameId: GAME_ID,
      zoneId: ZONE_ID,
      ...overrides,
    }));
  }

  async function seedClaimedChallenge(overrides: { expiresAt: Date }) {
    await testDatabase.db.insert(challengeClaims).values({
      id: CLAIM_ID,
      challengeId: CHALLENGE_ID,
      gameId: GAME_ID,
      teamId: TEAM_ONE_ID,
      playerId: PLAYER_ONE_ID,
      status: 'active',
      expiresAt: overrides.expiresAt,
      locationAtClaim: sql`ST_SetSRID(ST_MakePoint(${-97.1384}, ${49.8951}), 4326)`,
    });

    await testDatabase.db
      .update(challenges)
      .set({
        status: 'claimed',
        currentClaimId: CLAIM_ID,
        expiresAt: overrides.expiresAt,
      })
      .where(eq(challenges.id, CHALLENGE_ID));
  }
});

function adminHeaders(idempotencyKey: string) {
  return {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    'idempotency-key': idempotencyKey,
  };
}

function sessionCookie(sessionToken: string) {
  return `${SESSION_COOKIE_NAME}=${sessionToken}`;
}

function waitForSocketEvent<TPayload = any>(socket: ReturnType<typeof createSocketClient>, eventName: string): Promise<TPayload> {
  return new Promise((resolve) => {
    socket.once(eventName, (payload: TPayload) => resolve(payload));
  });
}
