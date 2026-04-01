import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { games, playerLocationSamples, players } from '../db/schema.js';
import { createTestApp } from '../test/create-test-app.js';
import { createTestGame, createTestPlayer } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { runPlayerLocationCleanup } from './player-location-cleanup.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';

describe('player location cleanup job', () => {
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

  it('deletes samples older than the configured retention window and keeps recent ones', async () => {
    await seedGame({
      settings: {
        location_tracking_enabled: true,
        location_retention_hours: 1,
      },
    });
    await seedPlayer({ teamId: null });
    await seedSample(new Date('2026-03-31T16:00:00.000Z'));
    await seedSample(new Date('2026-03-31T17:30:00.000Z'));
    app = await createTestApp({ db: testDatabase.db });

    const result = await runPlayerLocationCleanup(app, new Date('2026-03-31T18:00:00.000Z'));

    expect(result).toEqual({ deletedSamples: 1 });

    const remainingSamples = await testDatabase.db
      .select({ recordedAt: playerLocationSamples.recordedAt })
      .from(playerLocationSamples)
      .where(eq(playerLocationSamples.playerId, PLAYER_ID));

    expect(remainingSamples).toHaveLength(1);
    expect(remainingSamples[0]?.recordedAt.toISOString()).toBe('2026-03-31T17:30:00.000Z');
  });

  async function seedGame(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(games).values(createTestGame(overrides));
  }

  async function seedPlayer(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(players).values(createTestPlayer(overrides));
  }

  async function seedSample(recordedAt: Date) {
    await testDatabase.db.insert(playerLocationSamples).values({
      gameId: GAME_ID,
      playerId: PLAYER_ID,
      recordedAt,
      location: sql`ST_SetSRID(ST_MakePoint(${-97.1384}, ${49.8951}), 4326)`,
      gpsErrorMeters: 6,
      speedMps: null,
      headingDegrees: null,
      source: 'browser',
    });
  }
});
