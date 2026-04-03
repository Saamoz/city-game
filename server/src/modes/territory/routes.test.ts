import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { SESSION_COOKIE_NAME, STATE_VERSION_HEADER, eventTypes } from '@city-game/shared';
import { env } from '../../db/env.js';
import { challengeClaims, challenges, gameEvents, games, players, teams } from '../../db/schema.js';
import { createZone } from '../../services/spatial-service.js';
import { createTestApp } from '../../test/create-test-app.js';
import { createTestChallenge, createTestGame, createTestPlayer, createTestTeam } from '../../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../../test/test-db.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';
const CHALLENGE_ID = '55555555-5555-4555-8555-555555555555';
const SECOND_CHALLENGE_ID = '66666666-6666-4666-8666-666666666666';
const EXISTING_CLAIM_ID = '77777777-7777-4777-8777-777777777777';

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

describe('territory claim route', () => {
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

  it('claims an available challenge, increments state once, and logs both events', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'claim-success-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    app = await createTestApp({ db: testDatabase.db });

    const response = await claimRequest({
      sessionToken: 'claim-success-session',
      actionId: 'claim-success',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers[STATE_VERSION_HEADER.toLowerCase()]).toBe('1');
    expect(response.json()).toMatchObject({
      stateVersion: 1,
      challenge: {
        id: CHALLENGE_ID,
        status: 'claimed',
      },
      claim: {
        challengeId: CHALLENGE_ID,
        teamId: TEAM_ID,
        playerId: PLAYER_ID,
        status: 'active',
      },
    });
    expect(response.json().challenge.currentClaimId).toBe(response.json().claim.id);
    expect(response.json().challenge.expiresAt).toEqual(expect.any(String));

    const [storedGame] = await testDatabase.db
      .select({ stateVersion: games.stateVersion })
      .from(games)
      .where(eq(games.id, GAME_ID));
    expect(storedGame?.stateVersion).toBe(1);

    const [storedChallenge] = await testDatabase.db.select().from(challenges).where(eq(challenges.id, CHALLENGE_ID));
    expect(storedChallenge?.status).toBe('claimed');
    expect(storedChallenge?.currentClaimId).toBe(response.json().claim.id);

    const storedClaims = await testDatabase.db.select().from(challengeClaims).where(eq(challengeClaims.challengeId, CHALLENGE_ID));
    expect(storedClaims).toHaveLength(1);
    expect(storedClaims[0]?.status).toBe('active');

    const storedEvents = await testDatabase.db
      .select({ eventType: gameEvents.eventType, stateVersion: gameEvents.stateVersion })
      .from(gameEvents)
      .where(eq(gameEvents.gameId, GAME_ID))
      .orderBy(asc(gameEvents.createdAt));

    expect(storedEvents).toHaveLength(2);
    expect(storedEvents.map((event) => event.stateVersion)).toEqual([1, 1]);
    expect(storedEvents.map((event) => event.eventType).sort()).toEqual([
      eventTypes.challengeClaimed,
      eventTypes.objectiveStateChanged,
    ].sort());
  });


  it("claims a portable challenge against the player's current zone", async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'portable-claim-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: null, config: { portable: true } });
    app = await createTestApp({ db: testDatabase.db });

    const response = await claimRequest({
      sessionToken: 'portable-claim-session',
      actionId: 'portable-claim',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      challenge: {
        id: CHALLENGE_ID,
        status: 'claimed',
        zoneId: zone.id,
      },
    });

    const [storedChallenge] = await testDatabase.db.select().from(challenges).where(eq(challenges.id, CHALLENGE_ID));
    expect(storedChallenge?.zoneId).toBe(zone.id);
  });


  it('uses per-game claim_timeout_minutes when present', async () => {
    await seedGame({
      settings: {
        claim_timeout_minutes: 5,
      },
    });
    await seedTeam();
    await seedPlayer({ sessionToken: 'claim-timeout-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    app = await createTestApp({ db: testDatabase.db });

    const response = await claimRequest({
      sessionToken: 'claim-timeout-session',
      actionId: 'claim-timeout',
    });

    expect(response.statusCode).toBe(200);

    const [storedClaim] = await testDatabase.db
      .select({ claimedAt: challengeClaims.claimedAt, expiresAt: challengeClaims.expiresAt })
      .from(challengeClaims)
      .where(eq(challengeClaims.challengeId, CHALLENGE_ID))
      .limit(1);

    const claimDurationMs = storedClaim!.expiresAt.getTime() - storedClaim!.claimedAt.getTime();
    expect(claimDurationMs).toBeGreaterThanOrEqual(290_000);
    expect(claimDurationMs).toBeLessThanOrEqual(310_000);
  });

  it('replays the same successful claim for the same idempotency key', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'claim-replay-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    app = await createTestApp({ db: testDatabase.db });

    const payload = validGpsPayload();
    const firstResponse = await claimRequest({
      sessionToken: 'claim-replay-session',
      actionId: 'claim-replay',
      payload,
    });
    const secondResponse = await claimRequest({
      sessionToken: 'claim-replay-session',
      actionId: 'claim-replay',
      payload,
    });

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

  it('rejects challenges already marked as claimed', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'already-claimed-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    await seedActiveClaim({ challengeId: CHALLENGE_ID });
    await testDatabase.db
      .update(challenges)
      .set({ status: 'claimed', currentClaimId: EXISTING_CLAIM_ID })
      .where(eq(challenges.id, CHALLENGE_ID));
    app = await createTestApp({ db: testDatabase.db });

    const response = await claimRequest({
      sessionToken: 'already-claimed-session',
      actionId: 'already-claimed',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'CHALLENGE_ALREADY_CLAIMED',
        message: 'Challenge is already claimed by another team.',
      },
    });
  });

  it('rejects stale GPS payloads before territory logic runs', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'stale-gps-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    app = await createTestApp({ db: testDatabase.db });

    const response = await claimRequest({
      sessionToken: 'stale-gps-session',
      actionId: 'stale-gps',
      payload: {
        ...validGpsPayload(),
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

  it('rejects claim attempts outside the zone buffer and returns distance details', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'outside-zone-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    app = await createTestApp({ db: testDatabase.db });

    const response = await claimRequest({
      sessionToken: 'outside-zone-session',
      actionId: 'outside-zone',
      payload: {
        ...validGpsPayload(),
        lat: 49.905,
        lng: -97.12,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: 'OUTSIDE_ZONE',
        message: 'Player is outside the required zone.',
        details: {
          zoneId: zone.id,
          bufferMeters: 40,
        },
      },
    });
    expect(response.json().error.details.distanceMeters).toBeGreaterThan(0);
  });

  it('applies GPS accuracy threshold when require_gps_accuracy is enabled in game settings', async () => {
    await seedGame({ settings: { require_gps_accuracy: true } });
    await seedTeam();
    await seedPlayer({ sessionToken: 'zone-gps-session' });
    const zone = await seedZone({ maxGpsErrorMeters: 5 });
    await seedChallenge({ zoneId: zone.id });
    app = await createTestApp({ db: testDatabase.db });

    const response = await claimRequest({
      sessionToken: 'zone-gps-session',
      actionId: 'zone-gps',
      payload: {
        ...validGpsPayload(),
        gpsErrorMeters: 6,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: 'GPS_ERROR_TOO_HIGH',
        message: 'GPS accuracy is too low for this action.',
        details: {
          maxErrorMeters: 5,
          gpsErrorMeters: 6,
        },
      },
    });
  });

  it('rejects claims when the game is not active', async () => {
    await seedGame({ status: 'setup' });
    await seedTeam();
    await seedPlayer({ sessionToken: 'inactive-game-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    app = await createTestApp({ db: testDatabase.db });

    const response = await claimRequest({
      sessionToken: 'inactive-game-session',
      actionId: 'inactive-game',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'GAME_NOT_ACTIVE',
        message: 'Game is not active.',
        details: {
          gameId: GAME_ID,
          status: 'setup',
        },
      },
    });
  });

  it('rejects claims from players who are not on a team', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'no-team-session', teamId: null });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    app = await createTestApp({ db: testDatabase.db });

    const response = await claimRequest({
      sessionToken: 'no-team-session',
      actionId: 'no-team',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_ON_TEAM',
        message: 'Player must join a team first.',
      },
    });
  });

  it('enforces the max concurrent team claims setting', async () => {
    await seedGame({ settings: { max_concurrent_claims: 1 } });
    await seedTeam();
    await seedPlayer({ sessionToken: 'max-claims-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    await seedChallenge({ id: SECOND_CHALLENGE_ID, zoneId: zone.id, title: 'Second Challenge' });
    await seedActiveClaim({ challengeId: SECOND_CHALLENGE_ID });
    app = await createTestApp({ db: testDatabase.db });

    const response = await claimRequest({
      sessionToken: 'max-claims-session',
      actionId: 'max-claims',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'MAX_CONCURRENT_CLAIMS_REACHED',
        message: 'Team has reached the maximum number of active claims.',
        details: {
          teamId: TEAM_ID,
          activeClaimCount: 1,
          maxConcurrentClaims: 1,
        },
      },
    });
  });

  it('maps the active-claim unique index to challenge already claimed conflicts', async () => {
    await seedGame({ settings: { max_concurrent_claims: 2 } });
    await seedTeam();
    await seedPlayer({ sessionToken: 'unique-constraint-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    await seedActiveClaim({ challengeId: CHALLENGE_ID });
    app = await createTestApp({ db: testDatabase.db });

    const response = await claimRequest({
      sessionToken: 'unique-constraint-session',
      actionId: 'unique-constraint',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'CHALLENGE_ALREADY_CLAIMED',
        message: 'Challenge is already claimed by another team.',
      },
    });
  });

  async function claimRequest(input: {
    sessionToken: string;
    actionId: string;
    payload?: ReturnType<typeof validGpsPayload>;
  }) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${CHALLENGE_ID}/claim`,
      cookies: {
        [SESSION_COOKIE_NAME]: input.sessionToken,
      },
      headers: {
        'idempotency-key': input.actionId,
      },
      payload: input.payload ?? validGpsPayload(),
    });
  }

  async function seedGame(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(games).values(createTestGame({ status: 'active', ...overrides }));
  }

  async function seedTeam(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(teams).values(createTestTeam(overrides));
  }

  async function seedPlayer(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(players).values(createTestPlayer({ id: PLAYER_ID, ...overrides }));
  }

  async function seedZone(overrides: Record<string, unknown> = {}) {
    return createZone(testDatabase.db, {
      gameId: GAME_ID,
      name: 'Downtown Zone',
      geometry: ZONE_GEOMETRY,
      pointValue: 1,
      ...(overrides as {
        maxGpsErrorMeters?: number | null;
        claimRadiusMeters?: number | null;
      }),
    });
  }

  async function seedChallenge(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(challenges).values(createTestChallenge({
      id: CHALLENGE_ID,
      gameId: GAME_ID,
      zoneId: null,
      status: 'available',
      ...overrides,
    }));
  }

  async function seedActiveClaim(overrides: { challengeId: string }) {
    await testDatabase.db.insert(challengeClaims).values({
      id: EXISTING_CLAIM_ID,
      challengeId: overrides.challengeId,
      gameId: GAME_ID,
      teamId: TEAM_ID,
      playerId: PLAYER_ID,
      status: 'active',
      expiresAt: new Date(Date.now() + 5 * 60_000),
      locationAtClaim: sql`ST_SetSRID(ST_MakePoint(${-97.1384}, ${49.8951}), 4326)`,
    });
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
