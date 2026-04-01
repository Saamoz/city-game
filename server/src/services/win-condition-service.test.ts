import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { eventTypes, type GeoJsonPolygon } from '@city-game/shared';
import { games, gameEvents, teams } from '../db/schema.js';
import { createModeRegistry } from '../modes/index.js';
import { createTestGame, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { createZone } from './spatial-service.js';
import { transact } from './resource-service.js';
import { evaluateConfiguredWinConditions } from './win-condition-service.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ONE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_TWO_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';

const registry = createModeRegistry();

const BASE_LNG = -97.14;
const BASE_LAT = 49.894;

function squareGeometry(index: number) {
  const lng = BASE_LNG + index * 0.01;
  const lat = BASE_LAT + index * 0.002;

  return {
    type: 'Polygon',
    coordinates: [[
      [lng, lat],
      [lng + 0.004, lat],
      [lng + 0.004, lat + 0.002],
      [lng, lat + 0.002],
      [lng, lat],
    ]],
  } as unknown as GeoJsonPolygon;
}

describe('win condition service', () => {
  let testDatabase: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    testDatabase = await getTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('ends the game when one team owns all enabled zones', async () => {
    await seedGame({ winCondition: [{ type: 'all_zones' }] });
    await seedTeams();
    await seedZone(1, TEAM_ONE_ID);
    await seedZone(2, TEAM_ONE_ID);

    const result = await evaluateConfiguredWinConditions(testDatabase.db, registry, { gameId: GAME_ID });

    expect(result).toMatchObject({
      met: true,
      winnerTeamId: TEAM_ONE_ID,
      reason: 'all_zones',
      winCondition: { type: 'all_zones' },
      stateVersion: 1,
      game: {
        id: GAME_ID,
        status: 'completed',
      },
    });

    const [storedGame] = await testDatabase.db
      .select({ status: games.status, stateVersion: games.stateVersion, endedAt: games.endedAt })
      .from(games)
      .where(eq(games.id, GAME_ID));
    expect(storedGame).toMatchObject({
      status: 'completed',
      stateVersion: 1,
    });
    expect(storedGame?.endedAt).toBeInstanceOf(Date);

    const [endedEvent] = await latestGameEndedEvent();
    expect(endedEvent).toMatchObject({
      actorType: 'system',
      stateVersion: 1,
      meta: expect.objectContaining({
        trigger: 'win_condition',
        reason: 'all_zones',
        winnerTeamId: TEAM_ONE_ID,
        winCondition: { type: 'all_zones' },
      }),
    });
  });

  it('continues to later conditions when earlier ones are not met', async () => {
    await seedGame({
      winCondition: [
        { type: 'zone_majority', threshold: 0.75 },
        { type: 'score_threshold', target: 50 },
      ],
    });
    await seedTeams();
    await seedZone(1, TEAM_ONE_ID);
    await seedZone(2, TEAM_TWO_ID);
    await awardPoints(TEAM_ONE_ID, 60);

    const result = await evaluateConfiguredWinConditions(testDatabase.db, registry, { gameId: GAME_ID });

    expect(result).toMatchObject({
      met: true,
      winnerTeamId: TEAM_ONE_ID,
      reason: 'score_threshold',
      winCondition: { type: 'score_threshold', target: 50 },
    });
  });

  it('uses the first triggering condition when multiple conditions are satisfied', async () => {
    await seedGame({
      winCondition: [
        { type: 'score_threshold', target: 10 },
        { type: 'all_zones' },
      ],
    });
    await seedTeams();
    await seedZone(1, TEAM_ONE_ID);
    await seedZone(2, TEAM_ONE_ID);
    await awardPoints(TEAM_ONE_ID, 20);

    const result = await evaluateConfiguredWinConditions(testDatabase.db, registry, { gameId: GAME_ID });

    expect(result).toMatchObject({
      met: true,
      winnerTeamId: TEAM_ONE_ID,
      reason: 'score_threshold',
      winCondition: { type: 'score_threshold', target: 10 },
    });
  });

  it('ends the game when the zone majority threshold is reached', async () => {
    await seedGame({ winCondition: [{ type: 'zone_majority', threshold: 0.6 }] });
    await seedTeams();
    await seedZone(1, TEAM_ONE_ID);
    await seedZone(2, TEAM_ONE_ID);
    await seedZone(3, TEAM_ONE_ID);
    await seedZone(4, TEAM_TWO_ID);
    await seedZone(5, null);

    const result = await evaluateConfiguredWinConditions(testDatabase.db, registry, { gameId: GAME_ID });

    expect(result).toMatchObject({
      met: true,
      winnerTeamId: TEAM_ONE_ID,
      reason: 'zone_majority',
      winCondition: { type: 'zone_majority', threshold: 0.6 },
    });
  });

  it('ends the game when the score threshold is reached', async () => {
    await seedGame({ winCondition: [{ type: 'score_threshold', target: 50 }] });
    await seedTeams();
    await seedZone(1, null);
    await awardPoints(TEAM_ONE_ID, 50);

    const result = await evaluateConfiguredWinConditions(testDatabase.db, registry, { gameId: GAME_ID });

    expect(result).toMatchObject({
      met: true,
      winnerTeamId: TEAM_ONE_ID,
      reason: 'score_threshold',
      winCondition: { type: 'score_threshold', target: 50 },
    });
  });

  async function seedGame(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(games).values(createTestGame({ status: 'active', ...overrides }));
  }

  async function seedTeams() {
    await testDatabase.db.insert(teams).values(createTestTeam());
    await testDatabase.db.insert(teams).values(
      createTestTeam({
        id: TEAM_TWO_ID,
        name: 'Blue Team',
        color: '#2563eb',
        joinCode: 'BLUE1234',
      }),
    );
  }

  async function seedZone(index: number, ownerTeamId: string | null) {
    await createZone(testDatabase.db, {
      gameId: GAME_ID,
      name: `Zone ${index}`,
      geometry: squareGeometry(index),
      ownerTeamId,
      pointValue: 1,
    });
  }

  async function awardPoints(teamId: string, delta: number) {
    await transact(testDatabase.db, {
      gameId: GAME_ID,
      teamId,
      resourceType: 'points',
      delta,
      reason: 'test_points',
    });
  }

  function latestGameEndedEvent() {
    return testDatabase.db
      .select({ actorType: gameEvents.actorType, stateVersion: gameEvents.stateVersion, meta: gameEvents.meta })
      .from(gameEvents)
      .where(eq(gameEvents.eventType, eventTypes.gameEnded))
      .orderBy(desc(gameEvents.createdAt))
      .limit(1);
  }
});
