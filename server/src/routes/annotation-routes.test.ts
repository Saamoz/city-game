import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME, STATE_VERSION_HEADER, eventTypes, socketServerEventTypes } from '@city-game/shared';
import { annotations, gameEvents, games, players, teams } from '../db/schema.js';
import { createTestApp } from '../test/create-test-app.js';
import { createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';

const ADMIN_TOKEN = 'test-admin-token';
const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ONE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_TWO_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const PLAYER_ONE_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_TWO_ID = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';
const PUBLIC_ANNOTATION_ID = 'dddddddd-5555-4555-8555-dddddddddddd';
const TEAM_ANNOTATION_ID = 'eeeeeeee-6666-4666-8666-eeeeeeeeeeee';
const OTHER_TEAM_ANNOTATION_ID = 'ffffffff-7777-4777-8777-ffffffffffff';

describe('annotation routes', () => {
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

  it('lets a player create a marker annotation and broadcasts with the correct audience', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'marker-session' });
    app = await createAnnotationTestApp();
    const broadcastSpy = vi.spyOn(app.broadcaster, 'send').mockResolvedValue(1);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/annotations`,
      headers: idempotencyHeaders('annotation-create-marker'),
      cookies: {
        [SESSION_COOKIE_NAME]: 'marker-session',
      },
      payload: {
        type: 'marker',
        geometry: { type: 'Point', coordinates: [-97.136, 49.896] },
        label: 'Public Marker',
        style: { color: '#ffffff' },
        visibility: 'team',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers[STATE_VERSION_HEADER.toLowerCase()]).toBe('1');
    expect(response.json()).toMatchObject({
      annotation: {
        gameId: GAME_ID,
        createdBy: PLAYER_ONE_ID,
        type: 'marker',
        label: 'Public Marker',
        visibility: 'team',
      },
    });

    const [storedAnnotation] = await testDatabase.db.select().from(annotations).where(eq(annotations.gameId, GAME_ID));
    expect(storedAnnotation?.createdBy).toBe(PLAYER_ONE_ID);
    expect(storedAnnotation?.visibility).toBe('team');

    const [loggedEvent] = await testDatabase.db
      .select()
      .from(gameEvents)
      .where(and(eq(gameEvents.gameId, GAME_ID), eq(gameEvents.eventType, eventTypes.annotationAdded)))
      .orderBy(asc(gameEvents.createdAt));
    expect(loggedEvent).toMatchObject({
      actorType: 'player',
      actorId: PLAYER_ONE_ID,
      actorTeamId: TEAM_ONE_ID,
      entityType: 'annotation',
    });

    expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({
      gameId: GAME_ID,
      eventType: socketServerEventTypes.annotationAdded,
      stateVersion: 1,
      teamId: TEAM_ONE_ID,
    }));
  });

  it('rejects non-marker annotation creation for players', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'player-note-session' });
    app = await createAnnotationTestApp();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/annotations`,
      headers: idempotencyHeaders('annotation-create-note'),
      cookies: {
        [SESSION_COOKIE_NAME]: 'player-note-session',
      },
      payload: {
        type: 'note',
        geometry: { type: 'Point', coordinates: [-97.136, 49.896] },
        label: 'Not Allowed',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'ANNOTATION_FORBIDDEN',
        message: 'Players can only create marker annotations.',
      },
    });
  });

  it('lets an admin create non-marker annotations', async () => {
    await seedGame();
    app = await createAnnotationTestApp();
    const broadcastSpy = vi.spyOn(app.broadcaster, 'send').mockResolvedValue(1);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/annotations`,
      headers: adminHeaders('annotation-create-admin'),
      payload: {
        type: 'polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [-97.1405, 49.8944],
            [-97.1363, 49.8944],
            [-97.1363, 49.8962],
            [-97.1405, 49.8962],
            [-97.1405, 49.8944],
          ]],
        },
        label: 'Admin Polygon',
        style: { fill: '#2563eb' },
        visibility: 'all',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      annotation: {
        gameId: GAME_ID,
        createdBy: null,
        type: 'polygon',
        label: 'Admin Polygon',
        visibility: 'all',
      },
    });

    const [loggedEvent] = await testDatabase.db
      .select()
      .from(gameEvents)
      .where(and(eq(gameEvents.gameId, GAME_ID), eq(gameEvents.eventType, eventTypes.annotationAdded)))
      .orderBy(asc(gameEvents.createdAt));
    expect(loggedEvent).toMatchObject({
      actorType: 'admin',
      actorId: null,
      actorTeamId: null,
    });

    expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({
      teamId: undefined,
      eventType: socketServerEventTypes.annotationAdded,
    }));
  });

  it('filters annotation visibility for players and returns all annotations for admins', async () => {
    await seedGame();
    await seedTeam();
    await seedTeam({ id: TEAM_TWO_ID, name: 'Blue Team', color: '#2563eb', joinCode: 'BLUE1234' });
    await seedPlayer({ sessionToken: 'viewer-session' });
    await seedPlayer({
      id: PLAYER_TWO_ID,
      teamId: TEAM_TWO_ID,
      sessionToken: 'other-team-session',
      displayName: 'Player Two',
    });
    await seedAnnotations();
    app = await createAnnotationTestApp();

    const playerResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/annotations`,
      cookies: {
        [SESSION_COOKIE_NAME]: 'viewer-session',
      },
    });

    expect(playerResponse.statusCode).toBe(200);
    expect(playerResponse.json().annotations.map((annotation: { id: string }) => annotation.id)).toEqual([
      PUBLIC_ANNOTATION_ID,
      TEAM_ANNOTATION_ID,
    ]);

    const adminResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/game/${GAME_ID}/annotations`,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    });

    expect(adminResponse.statusCode).toBe(200);
    expect(adminResponse.json().annotations.map((annotation: { id: string }) => annotation.id)).toEqual([
      PUBLIC_ANNOTATION_ID,
      TEAM_ANNOTATION_ID,
      OTHER_TEAM_ANNOTATION_ID,
    ]);
  });

  it('lets players delete their own annotations and broadcasts the removal', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'delete-own-session' });
    await seedAnnotations([
      {
        id: TEAM_ANNOTATION_ID,
        gameId: GAME_ID,
        createdBy: PLAYER_ONE_ID,
        type: 'marker',
        geometry: { type: 'Point', coordinates: [-97.137, 49.897] },
        label: 'Own Team Marker',
        style: { color: '#ea580c' },
        visibility: 'team',
      },
    ]);
    app = await createAnnotationTestApp();
    const broadcastSpy = vi.spyOn(app.broadcaster, 'send').mockResolvedValue(1);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/annotations/${TEAM_ANNOTATION_ID}`,
      headers: idempotencyHeaders('annotation-delete-own'),
      cookies: {
        [SESSION_COOKIE_NAME]: 'delete-own-session',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers[STATE_VERSION_HEADER.toLowerCase()]).toBe('1');
    expect(response.json()).toEqual({ annotationId: TEAM_ANNOTATION_ID });

    const remainingAnnotations = await testDatabase.db.select().from(annotations).where(eq(annotations.gameId, GAME_ID));
    expect(remainingAnnotations).toHaveLength(0);

    const [loggedEvent] = await testDatabase.db
      .select()
      .from(gameEvents)
      .where(and(eq(gameEvents.gameId, GAME_ID), eq(gameEvents.eventType, eventTypes.annotationRemoved)))
      .orderBy(asc(gameEvents.createdAt));
    expect(loggedEvent).toMatchObject({
      actorType: 'player',
      actorId: PLAYER_ONE_ID,
      entityId: TEAM_ANNOTATION_ID,
    });

    expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({
      eventType: socketServerEventTypes.annotationRemoved,
      teamId: TEAM_ONE_ID,
      stateVersion: 1,
      payload: { annotationId: TEAM_ANNOTATION_ID },
    }));
  });

  it("rejects deletion of another player's annotation", async () => {
    await seedGame();
    await seedTeam();
    await seedTeam({ id: TEAM_TWO_ID, name: 'Blue Team', color: '#2563eb', joinCode: 'BLUE1234' });
    await seedPlayer({ sessionToken: 'delete-forbidden-session' });
    await seedPlayer({
      id: PLAYER_TWO_ID,
      teamId: TEAM_TWO_ID,
      sessionToken: 'other-delete-session',
      displayName: 'Player Two',
    });
    await seedAnnotations([
      {
        id: OTHER_TEAM_ANNOTATION_ID,
        gameId: GAME_ID,
        createdBy: PLAYER_TWO_ID,
        type: 'marker',
        geometry: { type: 'Point', coordinates: [-97.138, 49.898] },
        label: 'Other Team Marker',
        style: { color: '#2563eb' },
        visibility: 'team',
      },
    ]);
    app = await createAnnotationTestApp();

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/annotations/${OTHER_TEAM_ANNOTATION_ID}`,
      headers: idempotencyHeaders('annotation-delete-forbidden'),
      cookies: {
        [SESSION_COOKIE_NAME]: 'delete-forbidden-session',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'ANNOTATION_FORBIDDEN',
        message: 'Players can only delete their own annotations.',
      },
    });

    const storedAnnotations = await testDatabase.db.select().from(annotations).where(eq(annotations.id, OTHER_TEAM_ANNOTATION_ID));
    expect(storedAnnotations).toHaveLength(1);
  });

  async function createAnnotationTestApp() {
    return createTestApp({
      db: testDatabase.db,
      adminToken: ADMIN_TOKEN,
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

  async function seedAnnotations(rows?: Array<Record<string, unknown>>) {
    const annotationRows = (rows ?? [
      {
        id: PUBLIC_ANNOTATION_ID,
        gameId: GAME_ID,
        createdBy: PLAYER_ONE_ID,
        type: 'marker',
        geometry: { type: 'Point', coordinates: [-97.136, 49.896] },
        label: 'Public Marker',
        style: { color: '#ffffff' },
        visibility: 'all',
      },
      {
        id: TEAM_ANNOTATION_ID,
        gameId: GAME_ID,
        createdBy: PLAYER_ONE_ID,
        type: 'marker',
        geometry: { type: 'Point', coordinates: [-97.137, 49.897] },
        label: 'Team Marker',
        style: { color: '#ea580c' },
        visibility: 'team',
      },
      {
        id: OTHER_TEAM_ANNOTATION_ID,
        gameId: GAME_ID,
        createdBy: PLAYER_TWO_ID,
        type: 'marker',
        geometry: { type: 'Point', coordinates: [-97.138, 49.898] },
        label: 'Other Team Marker',
        style: { color: '#2563eb' },
        visibility: 'team',
      },
    ] ) as unknown as Array<typeof annotations.$inferInsert>;
    await testDatabase.db.insert(annotations).values(annotationRows);
  }
});

function idempotencyHeaders(key: string) {
  return {
    'Idempotency-Key': key,
  };
}

function adminHeaders(key: string) {
  return {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    'Idempotency-Key': key,
  };
}
