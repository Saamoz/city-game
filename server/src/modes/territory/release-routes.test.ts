import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { SESSION_COOKIE_NAME, STATE_VERSION_HEADER, eventTypes } from '@city-game/shared';
import { challengeClaims, challenges, gameEvents, games, players, teams } from '../../db/schema.js';
import { createZone } from '../../services/spatial-service.js';
import { createTestApp } from '../../test/create-test-app.js';
import { createTestChallenge, createTestGame, createTestPlayer, createTestTeam } from '../../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../../test/test-db.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ONE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_TWO_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const PLAYER_ONE_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_TWO_ID = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';
const CHALLENGE_ID = '55555555-5555-4555-8555-555555555555';
const CLAIM_ID = '77777777-7777-4777-8777-777777777777';

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

describe('territory release route', () => {
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

  it('releases an active claim, makes the challenge available, and logs release events', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'release-success-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    await seedClaimedChallenge({ expiresAt: new Date(Date.now() + 5 * 60_000) });
    app = await createTestApp({ db: testDatabase.db });

    const response = await releaseRequest({
      sessionToken: 'release-success-session',
      actionId: 'release-success',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers[STATE_VERSION_HEADER.toLowerCase()]).toBe('1');
    expect(response.json()).toMatchObject({
      stateVersion: 1,
      challenge: {
        id: CHALLENGE_ID,
        status: 'available',
        currentClaimId: null,
      },
      claim: {
        id: CLAIM_ID,
        status: 'released',
        teamId: TEAM_ONE_ID,
      },
    });

    const [storedGame] = await testDatabase.db
      .select({ stateVersion: games.stateVersion })
      .from(games)
      .where(eq(games.id, GAME_ID));
    expect(storedGame?.stateVersion).toBe(1);

    const [storedChallenge] = await testDatabase.db.select().from(challenges).where(eq(challenges.id, CHALLENGE_ID));
    expect(storedChallenge?.status).toBe('available');
    expect(storedChallenge?.currentClaimId).toBeNull();
    expect(storedChallenge?.expiresAt).toBeNull();

    const [storedClaim] = await testDatabase.db.select().from(challengeClaims).where(eq(challengeClaims.id, CLAIM_ID));
    expect(storedClaim?.status).toBe('released');
    expect(storedClaim?.releasedAt).toBeInstanceOf(Date);
    expect(storedClaim?.completedAt).toBeNull();

    const storedEvents = await testDatabase.db
      .select({ eventType: gameEvents.eventType, stateVersion: gameEvents.stateVersion })
      .from(gameEvents)
      .where(eq(gameEvents.gameId, GAME_ID))
      .orderBy(asc(gameEvents.createdAt));

    expect(storedEvents).toHaveLength(2);
    expect(storedEvents.map((event) => event.stateVersion)).toEqual([1, 1]);
    expect(storedEvents.map((event) => event.eventType).sort()).toEqual([
      eventTypes.objectiveStateChanged,
      eventTypes.challengeReleased,
    ].sort());
  });

  it('clears the temporary zone assignment when a portable claim is released', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'portable-release-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id, config: { portable: true } });
    await seedClaimedChallenge({ expiresAt: new Date(Date.now() + 5 * 60_000) });
    app = await createTestApp({ db: testDatabase.db });

    const response = await releaseRequest({
      sessionToken: 'portable-release-session',
      actionId: 'portable-release',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().challenge.zoneId).toBeNull();

    const [storedChallenge] = await testDatabase.db.select().from(challenges).where(eq(challenges.id, CHALLENGE_ID));
    expect(storedChallenge?.zoneId).toBeNull();
  });


  it('allows another team to claim the challenge after release', async () => {
    await seedGame();
    await seedTeam();
    await seedTeam({ id: TEAM_TWO_ID, name: 'Other Team', color: '#2563eb', joinCode: 'TEAM9999' });
    await seedPlayer({ sessionToken: 'release-team-one-session' });
    await seedPlayer({
      id: PLAYER_TWO_ID,
      teamId: TEAM_TWO_ID,
      sessionToken: 'release-team-two-session',
      displayName: 'Player Two',
    });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    await seedClaimedChallenge({ expiresAt: new Date(Date.now() + 5 * 60_000) });
    app = await createTestApp({ db: testDatabase.db });

    const releaseResponse = await releaseRequest({
      sessionToken: 'release-team-one-session',
      actionId: 'release-then-claim',
    });
    expect(releaseResponse.statusCode).toBe(200);

    const claimResponse = await claimRequest({
      sessionToken: 'release-team-two-session',
      actionId: 'claim-after-release',
    });

    expect(claimResponse.statusCode).toBe(200);
    expect(claimResponse.json()).toMatchObject({
      challenge: {
        id: CHALLENGE_ID,
        status: 'claimed',
      },
      claim: {
        teamId: TEAM_TWO_ID,
        playerId: PLAYER_TWO_ID,
        status: 'active',
      },
    });
  });

  it('replays the same successful release for the same idempotency key', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'release-replay-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    await seedClaimedChallenge({ expiresAt: new Date(Date.now() + 5 * 60_000) });
    app = await createTestApp({ db: testDatabase.db });

    const firstResponse = await releaseRequest({
      sessionToken: 'release-replay-session',
      actionId: 'release-replay',
    });
    const secondResponse = await releaseRequest({
      sessionToken: 'release-replay-session',
      actionId: 'release-replay',
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual(firstResponse.json());
    expect(secondResponse.headers[STATE_VERSION_HEADER.toLowerCase()]).toBe(
      firstResponse.headers[STATE_VERSION_HEADER.toLowerCase()],
    );

    const storedClaims = await testDatabase.db.select().from(challengeClaims).where(eq(challengeClaims.challengeId, CHALLENGE_ID));
    const storedEvents = await testDatabase.db.select().from(gameEvents).where(eq(gameEvents.gameId, GAME_ID));
    expect(storedClaims).toHaveLength(1);
    expect(storedEvents).toHaveLength(2);
  });

  async function releaseRequest(input: { sessionToken: string; actionId: string }) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${CHALLENGE_ID}/release`,
      cookies: {
        [SESSION_COOKIE_NAME]: input.sessionToken,
      },
      headers: {
        'idempotency-key': input.actionId,
      },
    });
  }

  async function claimRequest(input: { sessionToken: string; actionId: string }) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${CHALLENGE_ID}/claim`,
      cookies: {
        [SESSION_COOKIE_NAME]: input.sessionToken,
      },
      headers: {
        'idempotency-key': input.actionId,
      },
      payload: validGpsPayload(),
    });
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

  async function seedZone() {
    return createZone(testDatabase.db, {
      gameId: GAME_ID,
      name: 'Downtown Zone',
      geometry: ZONE_GEOMETRY,
      pointValue: 1,
    });
  }

  async function seedChallenge(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(challenges).values(createTestChallenge({
      id: CHALLENGE_ID,
      gameId: GAME_ID,
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

function validGpsPayload() {
  return {
    lat: 49.8951,
    lng: -97.1384,
    gpsErrorMeters: 5,
    capturedAt: new Date().toISOString(),
  };
}
