import type { FastifyInstance } from 'fastify';
import type { GeoJsonPolygon } from '@city-game/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { challenges, games } from '../db/schema.js';
import { createZone } from '../services/spatial-service.js';
import { createTestApp } from '../test/create-test-app.js';
import { createTestChallenge, createTestGame } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';

const ADMIN_TOKEN = 'test-admin-token';
const GAME_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_GAME_ID = '66666666-6666-4666-8666-666666666666';
const CHALLENGE_ID = '55555555-5555-4555-8555-555555555555';

describe('challenge routes', () => {
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

  it('creates challenges with different kinds and completion modes', async () => {
    await seedGame();
    const zone = await seedZone();
    app = await createChallengeTestApp();

    const visitResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/challenges`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        zoneId: zone.id,
        title: 'Visit Checkpoint',
        description: 'Reach the zone.',
        kind: 'visit',
      },
    });

    const quizResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/challenges`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        title: 'Solve Quiz',
        description: 'Answer the prompt.',
        kind: 'quiz',
        completionMode: 'quiz',
        config: {
          question: 'What is 2 + 2?',
        },
        scoring: {
          points: 25,
        },
        difficulty: 'medium',
      },
    });

    expect(visitResponse.statusCode).toBe(201);
    expect(visitResponse.json().challenge).toMatchObject({
      zoneId: zone.id,
      kind: 'visit',
      completionMode: 'self_report',
      status: 'available',
    });

    expect(quizResponse.statusCode).toBe(201);
    expect(quizResponse.json().challenge).toMatchObject({
      kind: 'quiz',
      completionMode: 'quiz',
      difficulty: 'medium',
      scoring: { points: 25 },
    });
  });

  it('rejects zone ids that belong to another game', async () => {
    await seedGame();
    await seedOtherGame();
    const otherZone = await seedOtherZone();
    app = await createChallengeTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/challenges`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        zoneId: otherZone.id,
        title: 'Cross Game Zone',
        description: 'Should fail.',
        kind: 'visit',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Zone does not belong to this game.',
      },
    });
  });

  it('filters challenges by zone, kind, and status', async () => {
    await seedGame();
    const zone = await seedZone();
    await seedChallenge({
      id: CHALLENGE_ID,
      zoneId: zone.id,
      kind: 'photo',
      status: 'available',
      title: 'Photo One',
    });
    await seedChallenge({
      id: '99999999-9999-4999-8999-999999999999',
      zoneId: null,
      kind: 'quiz',
      status: 'claimed',
      title: 'Quiz One',
    });
    app = await createChallengeTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/challenges?zoneId=${zone.id}&kind=photo&status=available`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().challenges).toHaveLength(1);
    expect(response.json().challenges[0]).toMatchObject({
      id: CHALLENGE_ID,
      kind: 'photo',
      status: 'available',
      zoneId: zone.id,
    });
  });

  it('updates and deletes a challenge', async () => {
    await seedGame();
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    app = await createChallengeTestApp();

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/challenges/${CHALLENGE_ID}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        title: 'Updated Challenge',
        kind: 'photo',
        completionMode: 'proof_photo',
        status: 'claimed',
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().challenge).toMatchObject({
      id: CHALLENGE_ID,
      title: 'Updated Challenge',
      kind: 'photo',
      completionMode: 'proof_photo',
      status: 'claimed',
    });

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/challenges/${CHALLENGE_ID}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(deleteResponse.statusCode).toBe(204);

    const [storedChallenge] = await testDatabase.db
      .select()
      .from(challenges)
      .where(eq(challenges.id, CHALLENGE_ID))
      .limit(1);

    expect(storedChallenge).toBeUndefined();
  });

  it('validates completionMode shape', async () => {
    await seedGame();
    app = await createChallengeTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/challenges`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        title: 'Bad Mode',
        description: 'Should fail.',
        kind: 'visit',
        completionMode: 'bad-mode',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  async function createChallengeTestApp() {
    return createTestApp({
      db: testDatabase.db,
      adminToken: ADMIN_TOKEN,
    });
  }

  async function seedGame() {
    await testDatabase.db.insert(games).values(createTestGame());
  }

  async function seedOtherGame() {
    await testDatabase.db.insert(games).values(
      createTestGame({
        id: OTHER_GAME_ID,
        name: 'Other Game',
      }),
    );
  }

  async function seedZone() {
    return createZone(testDatabase.db, {
      gameId: GAME_ID,
      name: 'Challenge Zone',
      geometry: createSquarePolygon(),
      metadata: {},
    });
  }

  async function seedOtherZone() {
    return createZone(testDatabase.db, {
      gameId: OTHER_GAME_ID,
      name: 'Other Zone',
      geometry: createSquarePolygon(-97.1404, 49.8948),
      metadata: {},
    });
  }

  async function seedChallenge(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(challenges).values(createTestChallenge(overrides));
  }
});

function createSquarePolygon(lng = -97.1395, lat = 49.8952, size = 0.0005): GeoJsonPolygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng, lat],
        [lng + size, lat],
        [lng + size, lat + size],
        [lng, lat + size],
        [lng, lat],
      ],
    ],
  };
}
