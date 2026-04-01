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
const PLAYER_ONE_ID = '33333333-3333-4333-8333-333333333333';
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

describe('territory win condition routes', () => {
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

  it('auto-ends the game after a completion meets the win condition', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'win-route-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id, scoring: { points: 10 } });
    await seedClaimedChallenge({ expiresAt: new Date(Date.now() + 5 * 60_000) });
    app = await createTestApp({ db: testDatabase.db });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${CHALLENGE_ID}/complete`,
      cookies: {
        [SESSION_COOKIE_NAME]: 'win-route-session',
      },
      headers: {
        'idempotency-key': 'win-route-complete',
      },
      payload: {
        submission: {
          note: 'done',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers[STATE_VERSION_HEADER.toLowerCase()]).toBe('1');

    const storedGame = await waitForCompletedGame();
    expect(storedGame.status).toBe('completed');
    expect(storedGame.stateVersion).toBe(2);
    expect(storedGame.endedAt).toBeInstanceOf(Date);

    const storedEvents = await testDatabase.db
      .select({ eventType: gameEvents.eventType, stateVersion: gameEvents.stateVersion, meta: gameEvents.meta })
      .from(gameEvents)
      .where(eq(gameEvents.gameId, GAME_ID))
      .orderBy(asc(gameEvents.stateVersion), asc(gameEvents.createdAt));

    expect(storedEvents.at(-1)).toMatchObject({
      eventType: eventTypes.gameEnded,
      stateVersion: 2,
      meta: expect.objectContaining({
        reason: 'all_zones',
        winnerTeamId: TEAM_ONE_ID,
        winCondition: { type: 'all_zones' },
      }),
    });
  });

  async function seedGame(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(games).values(
      createTestGame({
        status: 'active',
        winCondition: [{ type: 'all_zones' }],
        ...overrides,
      }),
    );
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
      name: 'Victory Zone',
      geometry: ZONE_GEOMETRY,
      pointValue: 1,
    });
  }

  async function seedChallenge(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(challenges).values(
      createTestChallenge({
        id: CHALLENGE_ID,
        gameId: GAME_ID,
        ...overrides,
      }),
    );
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

  async function waitForCompletedGame() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const [storedGame] = await testDatabase.db
        .select({ status: games.status, stateVersion: games.stateVersion, endedAt: games.endedAt })
        .from(games)
        .where(eq(games.id, GAME_ID));

      if (storedGame?.status === 'completed' && storedGame.stateVersion === 2 && storedGame.endedAt) {
        return storedGame;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error('Timed out waiting for win-condition game end.');
  }
});
