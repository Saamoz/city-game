import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../test/create-test-app.js';
import { createTestGame, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { games, teams } from '../db/schema.js';
import { transact } from '../services/resource-service.js';
import { createZone } from '../services/spatial-service.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_RED_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_BLUE_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const TEAM_GREEN_ID = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';

const BASE_GEOMETRY = {
  type: 'Polygon',
  coordinates: [[
    [-97.1405, 49.8944],
    [-97.1363, 49.8944],
    [-97.1363, 49.8962],
    [-97.1405, 49.8962],
    [-97.1405, 49.8944],
  ]],
} as const;

describe('scoreboard routes', () => {
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

  it('returns ranked standings using zone count only and ignores resource balances for ordering', async () => {
    await seedGame();
    await seedTeams();
    await seedZone('Red One', TEAM_RED_ID, 0);
    await seedZone('Red Two', TEAM_RED_ID, 1);
    await seedZone('Blue One', TEAM_BLUE_ID, 2);

    await transact(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_BLUE_ID,
      resourceType: 'points',
      delta: 30,
      reason: 'scoreboard_seed',
    });
    await transact(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_GREEN_ID,
      resourceType: 'coins',
      delta: 99,
      reason: 'scoreboard_seed',
    });

    app = await createScoreboardTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/scoreboard`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      scoreboard: [
        {
          team: expect.objectContaining({ id: TEAM_RED_ID, name: 'Red Team' }),
          zoneCount: 2,
          resources: { points: 0, coins: 0 },
          rank: 1,
        },
        {
          team: expect.objectContaining({ id: TEAM_BLUE_ID, name: 'Blue Team' }),
          zoneCount: 1,
          resources: { points: 30, coins: 0 },
          rank: 2,
        },
        {
          team: expect.objectContaining({ id: TEAM_GREEN_ID, name: 'Green Team' }),
          zoneCount: 0,
          resources: { points: 0, coins: 99 },
          rank: 3,
        },
      ],
    });
  });

  it('breaks ties by deterministic team ordering after zone count', async () => {
    await seedGame();
    await seedTeams();
    await seedZone('Blue One', TEAM_BLUE_ID, 0);
    await seedZone('Blue Two', TEAM_BLUE_ID, 1);
    await seedZone('Green One', TEAM_GREEN_ID, 2);
    await seedZone('Green Two', TEAM_GREEN_ID, 3);
    await seedZone('Red One', TEAM_RED_ID, 4);

    await transact(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_GREEN_ID,
      resourceType: 'points',
      delta: 100,
      reason: 'scoreboard_tie_seed',
    });
    await transact(testDatabase.db, {
      gameId: GAME_ID,
      teamId: TEAM_BLUE_ID,
      resourceType: 'coins',
      delta: 1,
      reason: 'scoreboard_tie_seed',
    });

    app = await createScoreboardTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/scoreboard`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().scoreboard.map((entry: { team: { id: string }; rank: number; zoneCount: number }) => ({
      id: entry.team.id,
      rank: entry.rank,
      zoneCount: entry.zoneCount,
    }))).toEqual([
      { id: TEAM_BLUE_ID, rank: 1, zoneCount: 2 },
      { id: TEAM_GREEN_ID, rank: 2, zoneCount: 2 },
      { id: TEAM_RED_ID, rank: 3, zoneCount: 1 },
    ]);
  });

  it('returns an empty scoreboard for a game with no teams', async () => {
    await seedGame();
    app = await createScoreboardTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/scoreboard`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ scoreboard: [] });
  });

  async function createScoreboardTestApp() {
    return createTestApp({ db: testDatabase.db });
  }

  async function seedGame() {
    await testDatabase.db.insert(games).values(createTestGame());
  }

  async function seedTeams() {
    await testDatabase.db.insert(teams).values([
      createTestTeam({ id: TEAM_RED_ID, name: 'Red Team', color: '#ea580c', joinCode: 'RED12345' }),
      createTestTeam({ id: TEAM_BLUE_ID, name: 'Blue Team', color: '#2563eb', joinCode: 'BLUE1234' }),
      createTestTeam({ id: TEAM_GREEN_ID, name: 'Green Team', color: '#16a34a', joinCode: 'GREEN123' }),
    ]);
  }

  async function seedZone(name: string, ownerTeamId: string, offset: number) {
    const lngOffset = offset * 0.01;
    await createZone(testDatabase.db, {
      gameId: GAME_ID,
      name,
      ownerTeamId,
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [BASE_GEOMETRY.coordinates[0][0][0] + lngOffset, BASE_GEOMETRY.coordinates[0][0][1]],
          [BASE_GEOMETRY.coordinates[0][1][0] + lngOffset, BASE_GEOMETRY.coordinates[0][1][1]],
          [BASE_GEOMETRY.coordinates[0][2][0] + lngOffset, BASE_GEOMETRY.coordinates[0][2][1]],
          [BASE_GEOMETRY.coordinates[0][3][0] + lngOffset, BASE_GEOMETRY.coordinates[0][3][1]],
          [BASE_GEOMETRY.coordinates[0][4][0] + lngOffset, BASE_GEOMETRY.coordinates[0][4][1]],
        ]],
      },
      pointValue: 5,
      metadata: {},
    });
  }
});
