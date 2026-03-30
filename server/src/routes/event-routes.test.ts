import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eventTypes, MAX_DELTA_SYNC_GAP } from '@city-game/shared';
import { games } from '../db/schema.js';
import { getTestDatabase, resetTestDatabase, closeTestDatabase } from '../test/test-db.js';
import { createTestApp } from '../test/create-test-app.js';
import { createTestGame } from '../test/factories.js';
import { logEvent } from '../services/event-service.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const CHALLENGE_ID = '55555555-5555-4555-8555-555555555555';
const ZONE_ID = '44444444-4444-4444-8444-444444444444';

describe('event routes', () => {
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

  it('returns recent events with eventType filtering', async () => {
    await seedGame();
    await seedEvents();
    app = await createEventTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/game/' + GAME_ID + '/events?eventType=' + eventTypes.resourceChanged,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().events).toHaveLength(1);
    expect(response.json().events[0]).toMatchObject({
      eventType: 'RESOURCE_CHANGED',
      stateVersion: 3,
    });
  });

  it('returns delta events since a version', async () => {
    await seedGame();
    await seedEvents();
    app = await createEventTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/game/' + GAME_ID + '/events/since/1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      stateVersion: 3,
      fullSyncRequired: false,
    });
    expect(response.json().events.map((event: { stateVersion: number }) => event.stateVersion)).toEqual([2, 3]);
  });

  it('flags fullSyncRequired when the delta gap is too large', async () => {
    await seedGame({ stateVersion: MAX_DELTA_SYNC_GAP + 10 });
    app = await createEventTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/game/' + GAME_ID + '/events/since/0',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      events: [],
      stateVersion: MAX_DELTA_SYNC_GAP + 10,
      fullSyncRequired: true,
    });
  });

  async function createEventTestApp() {
    return createTestApp({
      db: testDatabase.db,
    });
  }

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
