import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventTypes, socketServerEventTypes, type GeoJsonPolygon } from '@city-game/shared';
import { games, gameEvents, teams } from '../db/schema.js';
import { createTestApp } from '../test/create-test-app.js';
import { createTestGame, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { createZone } from '../services/spatial-service.js';
import { transact } from '../services/resource-service.js';
import { runWinConditionSweep } from './win-condition.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ONE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_TWO_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';

function squareGeometry(index: number) {
  const lng = -97.11 + index * 0.01;
  const lat = 49.89 + index * 0.002;

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

describe('win condition job', () => {
  let app: FastifyInstance;
  let testDatabase: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    testDatabase = await getTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('ends expired time-limit games and broadcasts game_ended', async () => {
    await seedGame();
    await seedTeams();
    await seedZone(1, TEAM_ONE_ID);
    await seedZone(2, TEAM_TWO_ID);
    await awardPoints(TEAM_TWO_ID, 25);
    app = await createTestApp({ db: testDatabase.db });
    const sendSpy = vi.spyOn(app.broadcaster, 'send').mockResolvedValue(1);

    const result = await runWinConditionSweep(app, new Date('2026-03-31T18:00:00.000Z'));

    expect(result).toEqual({ endedGames: 1 });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        gameId: GAME_ID,
        eventType: socketServerEventTypes.gameEnded,
        modeKey: 'territory',
        stateVersion: 1,
      }),
    );

    const [storedGame] = await testDatabase.db
      .select({ status: games.status, stateVersion: games.stateVersion })
      .from(games)
      .where(eq(games.id, GAME_ID));
    expect(storedGame).toEqual({ status: 'completed', stateVersion: 1 });

    const [endedEvent] = await testDatabase.db
      .select({ eventType: gameEvents.eventType, actorType: gameEvents.actorType, meta: gameEvents.meta })
      .from(gameEvents)
      .where(eq(gameEvents.eventType, eventTypes.gameEnded))
      .limit(1);
    expect(endedEvent).toMatchObject({
      eventType: eventTypes.gameEnded,
      actorType: 'system',
      meta: expect.objectContaining({
        reason: 'time_limit',
        winnerTeamId: TEAM_TWO_ID,
        winCondition: { type: 'time_limit', duration_minutes: 60 },
      }),
    });
  });

  async function seedGame() {
    await testDatabase.db.insert(games).values(
      createTestGame({
        status: 'active',
        startedAt: new Date('2026-03-31T16:30:00.000Z'),
        winCondition: [{ type: 'time_limit', duration_minutes: 60 }],
      }),
    );
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
      name: `Time Limit Zone ${index}`,
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
      reason: 'time_limit_tiebreak',
    });
  }
});
