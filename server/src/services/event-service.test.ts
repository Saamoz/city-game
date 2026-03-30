import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eventTypes, MAX_DELTA_SYNC_GAP } from '@city-game/shared';
import { eq } from 'drizzle-orm';
import { gameEvents, games } from '../db/schema.js';
import { createTestGame } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { getEventsSince, getRecentEvents, logEvent } from './event-service.js';
import { incrementVersion } from './game-service.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const CHALLENGE_ID = '55555555-5555-4555-8555-555555555555';
const ZONE_ID = '44444444-4444-4444-8444-444444444444';

describe('event service', () => {
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

  it('increments state version and logs events atomically', async () => {
    await seedGame();

    const firstVersion = await incrementVersion(testDatabase.db, GAME_ID);
    expect(firstVersion).toBe(1);

    const event = await logEvent(testDatabase.db, {
      gameId: GAME_ID,
      eventType: eventTypes.resourceChanged,
      entityType: 'resource_ledger',
      entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      actorType: 'system',
      afterState: { balanceAfter: 10 },
      meta: { resourceType: 'points' },
    });

    expect(event.stateVersion).toBe(2);
    expect(event.eventType).toBe('RESOURCE_CHANGED');

    const [storedGame] = await testDatabase.db
      .select({ stateVersion: games.stateVersion })
      .from(games)
      .where(eq(games.id, GAME_ID))
      .limit(1);

    expect(storedGame?.stateVersion).toBe(2);

    const [storedEvent] = await testDatabase.db
      .select({ stateVersion: gameEvents.stateVersion, eventType: gameEvents.eventType })
      .from(gameEvents)
      .where(eq(gameEvents.id, event.id))
      .limit(1);

    expect(storedEvent).toEqual({
      stateVersion: 2,
      eventType: 'RESOURCE_CHANGED',
    });
  });

  it('returns recent events in descending version order with filters', async () => {
    await seedGame();
    await seedEvents();

    const recentEvents = await getRecentEvents(testDatabase.db, {
      gameId: GAME_ID,
      eventType: eventTypes.controlStateChanged,
    });

    expect(recentEvents).toHaveLength(1);
    expect(recentEvents[0]).toMatchObject({
      eventType: 'CONTROL_STATE_CHANGED',
      entityId: ZONE_ID,
      stateVersion: 2,
    });
  });

  it('returns delta events since a version in ascending order', async () => {
    await seedGame();
    await seedEvents();

    const result = await getEventsSince(testDatabase.db, {
      gameId: GAME_ID,
      sinceVersion: 1,
    });

    expect(result.fullSyncRequired).toBe(false);
    expect(result.stateVersion).toBe(3);
    expect(result.events.map((event) => event.stateVersion)).toEqual([2, 3]);
    expect(result.events[0]).toMatchObject({
      eventType: 'CONTROL_STATE_CHANGED',
    });
  });

  it('requests a full sync when the delta gap exceeds the threshold', async () => {
    await seedGame({ stateVersion: MAX_DELTA_SYNC_GAP + 5 });

    const result = await getEventsSince(testDatabase.db, {
      gameId: GAME_ID,
      sinceVersion: 0,
    });

    expect(result).toEqual({
      events: [],
      stateVersion: MAX_DELTA_SYNC_GAP + 5,
      fullSyncRequired: true,
    });
  });

  async function seedGame(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(games).values(createTestGame(overrides));
  }

  async function seedEvents() {
    await logEvent(testDatabase.db, {
      gameId: GAME_ID,
      eventType: eventTypes.objectiveStateChanged,
      entityType: 'challenge',
      entityId: CHALLENGE_ID,
      actorType: 'system',
      afterState: { status: 'claimed' },
      meta: { source: 'test' },
    });

    await logEvent(testDatabase.db, {
      gameId: GAME_ID,
      eventType: eventTypes.controlStateChanged,
      entityType: 'zone',
      entityId: ZONE_ID,
      actorType: 'team',
      actorTeamId: '22222222-2222-4222-8222-222222222222',
      afterState: { ownerTeamId: '22222222-2222-4222-8222-222222222222' },
      meta: { source: 'test' },
    });

    await logEvent(testDatabase.db, {
      gameId: GAME_ID,
      eventType: eventTypes.resourceChanged,
      entityType: 'resource_ledger',
      entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      actorType: 'system',
      afterState: { balanceAfter: 10 },
      meta: { resourceType: 'points' },
    });
  }
});
