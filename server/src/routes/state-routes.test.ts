import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME } from '@city-game/shared';
import { annotations, challengeClaims, challenges, games, players, teams } from '../db/schema.js';
import { createTestApp } from '../test/create-test-app.js';
import { createTestChallenge, createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { transact } from '../services/resource-service.js';
import { createZone } from '../services/spatial-service.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ONE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_TWO_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const PLAYER_ONE_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_TWO_ID = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';
const CLAIM_ID = 'cccccccc-4444-4444-8444-cccccccccccc';

describe('state routes', () => {
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

  it('requires authentication for map-state', async () => {
    await seedGame();
    app = await createStateTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/map-state`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
      },
    });
  });

  it('returns a full filtered snapshot for the authenticated player', async () => {
    await seedGame();
    await seedTeam();
    await seedTeam({
      id: TEAM_TWO_ID,
      name: 'Blue Team',
      color: '#0000ff',
      joinCode: 'BLUE1234',
    });
    await seedPlayer({ teamId: TEAM_ONE_ID, sessionToken: 'viewer-session' });
    await seedPlayer({
      id: PLAYER_TWO_ID,
      teamId: TEAM_TWO_ID,
      sessionToken: 'other-session',
      displayName: 'Player Two',
    });

    const zone = await createZone(testDatabase.db, {
      gameId: GAME_ID,
      name: 'Central Zone',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-97.14, 49.89],
          [-97.13, 49.89],
          [-97.13, 49.9],
          [-97.14, 49.9],
          [-97.14, 49.89],
        ]],
      },
      pointValue: 5,
      metadata: { district: 'central' },
    });

    const challenge = createTestChallenge({
      zoneId: zone.id,
      scoring: { points: 25 },
    });
    await testDatabase.db.insert(challenges).values(challenge);
    await testDatabase.db.insert(challengeClaims).values({
      id: CLAIM_ID,
      challengeId: challenge.id,
      gameId: GAME_ID,
      teamId: TEAM_ONE_ID,
      playerId: PLAYER_ONE_ID,
      status: 'active',
      expiresAt: new Date('2026-03-31T12:10:00.000Z'),
      submission: null,
    } as typeof challengeClaims.$inferInsert);
    await testDatabase.db.update(challenges).set({ currentClaimId: CLAIM_ID, status: 'claimed' }).where(eq(challenges.id, challenge.id));

    await testDatabase.db.insert(annotations).values([
      {
        id: 'dddddddd-5555-4555-8555-dddddddddddd',
        gameId: GAME_ID,
        createdBy: PLAYER_ONE_ID,
        type: 'marker',
        geometry: { type: 'Point', coordinates: [-97.136, 49.896] },
        label: 'Public Marker',
        style: { color: '#ffffff' },
        visibility: 'all',
      },
      {
        id: 'eeeeeeee-6666-4666-8666-eeeeeeeeeeee',
        gameId: GAME_ID,
        createdBy: PLAYER_ONE_ID,
        type: 'marker',
        geometry: { type: 'Point', coordinates: [-97.137, 49.897] },
        label: 'Team Marker',
        style: { color: '#ea580c' },
        visibility: 'team',
      },
      {
        id: 'ffffffff-7777-4777-8777-ffffffffffff',
        gameId: GAME_ID,
        createdBy: PLAYER_TWO_ID,
        type: 'marker',
        geometry: { type: 'Point', coordinates: [-97.138, 49.898] },
        label: 'Other Team Marker',
        style: { color: '#2563eb' },
        visibility: 'team',
      },
    ] as unknown as Array<typeof annotations.$inferInsert>);

    await transact(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_ONE_ID,
      resourceType: 'points',
      delta: 25,
      reason: 'snapshot_test',
    });
    await transact(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_TWO_ID,
      resourceType: 'coins',
      delta: 5,
      reason: 'snapshot_test',
    });

    app = await createStateTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/map-state`,
      cookies: {
        [SESSION_COOKIE_NAME]: 'viewer-session',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      snapshot: {
        game: {
          id: GAME_ID,
          modeKey: 'territory',
        },
        player: {
          id: PLAYER_ONE_ID,
          teamId: TEAM_ONE_ID,
        },
        team: {
          id: TEAM_ONE_ID,
        },
        teams: [{ id: TEAM_ONE_ID }, { id: TEAM_TWO_ID }],
        players: [{ id: PLAYER_ONE_ID }, { id: PLAYER_TWO_ID }],
        zones: [{ id: zone.id, name: 'Central Zone' }],
        challenges: [{ id: challenge.id, currentClaimId: CLAIM_ID, status: 'claimed' }],
        claims: [{ id: CLAIM_ID, teamId: TEAM_ONE_ID, playerId: PLAYER_ONE_ID }],
      },
    });

    const snapshot = response.json().snapshot;
    expect(snapshot.player.sessionToken).toBeUndefined();
    expect(snapshot.annotations.map((annotation: { id: string }) => annotation.id)).toEqual([
      'dddddddd-5555-4555-8555-dddddddddddd',
      'eeeeeeee-6666-4666-8666-eeeeeeeeeeee',
    ]);
    expect(snapshot.teamResources[TEAM_ONE_ID]).toEqual({ points: 25, coins: 0 });
    expect(snapshot.teamResources[TEAM_TWO_ID]).toEqual({ points: 0, coins: 5 });
  });

  async function createStateTestApp() {
    return createTestApp({
      db: testDatabase.db,
    });
  }

  async function seedGame(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(games).values(createTestGame(overrides));
  }

  async function seedTeam(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(teams).values(createTestTeam({ gameId: GAME_ID, ...overrides }));
  }

  async function seedPlayer(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(players).values(createTestPlayer({ gameId: GAME_ID, id: PLAYER_ONE_ID, ...overrides }));
  }
});
