import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  MAX_DELTA_SYNC_GAP,
  SESSION_COOKIE_NAME,
  eventTypes,
  socketClientEventTypes,
  socketServerEventTypes,
  type GameStateSnapshot,
} from '@city-game/shared';
import { createModeRegistry } from '../modes/index.js';
import { createTerritoryModeHandler } from '../modes/territory/handler.js';
import type { ModeHandler } from '../modes/types.js';
import { games, players, teams } from '../db/schema.js';
import { createTestApp, type CreateTestAppOptions } from '../test/create-test-app.js';
import { createSocketClient, connectSocketClient } from '../test/socket-client-factory.js';
import { createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { serializeGameRecord } from '../services/game-service.js';
import { logEvent } from '../services/event-service.js';

const ADMIN_TOKEN = 'test-admin-token';
const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ONE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_TWO_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const PLAYER_ONE_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_TWO_ID = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';

describe('realtime socket server', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let testDatabase: Awaited<ReturnType<typeof getTestDatabase>>;
  const sockets: Array<ReturnType<typeof createSocketClient>> = [];

  beforeAll(async () => {
    testDatabase = await getTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    sockets.length = 0;
    baseUrl = '';
  });

  afterEach(async () => {
    for (const socket of sockets) {
      socket.removeAllListeners();
      socket.disconnect();
      socket.close();
    }

    await app?.close();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('rejects socket connections without a valid session cookie', async () => {
    await seedGame();
    app = await createRealtimeTestApp();
    baseUrl = await listenApp(app);

    const socket = trackSocket(createSocketClient({ url: baseUrl }));

    await expect(connectSocketClient(socket)).rejects.toMatchObject({
      message: 'Authentication required.',
      data: {
        code: 'UNAUTHORIZED',
      },
    });
  });

  it('sends a full snapshot when joining without a last state version', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ teamId: TEAM_ONE_ID, sessionToken: 'sync-session' });
    app = await createRealtimeTestApp();
    baseUrl = await listenApp(app);

    const socket = trackSocket(createSocketClient({
      url: baseUrl,
      cookie: sessionCookie('sync-session'),
    }));
    await connectSocketClient(socket);

    const syncPromise = waitForSocketEvent(socket, socketServerEventTypes.gameStateSync);
    const joinResult = await socket.timeout(1000).emitWithAck(socketClientEventTypes.joinGame, {
      gameId: GAME_ID,
    });

    expect(joinResult).toEqual({
      ok: true,
      gameId: GAME_ID,
      teamId: TEAM_ONE_ID,
    });

    const syncEvent = await syncPromise;
    expect(syncEvent).toMatchObject({
      gameId: GAME_ID,
      stateVersion: 0,
      snapshot: {
        game: { id: GAME_ID },
        player: { id: PLAYER_ONE_ID, teamId: TEAM_ONE_ID },
        team: { id: TEAM_ONE_ID },
      },
    });
    expect(syncEvent.serverTime).toEqual(expect.any(String));
  });

  it('sends delta events when reconnecting within the delta threshold', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ teamId: TEAM_ONE_ID, sessionToken: 'delta-session' });
    await seedRealtimeEvents();
    app = await createRealtimeTestApp();
    baseUrl = await listenApp(app);

    const socket = trackSocket(createSocketClient({
      url: baseUrl,
      cookie: sessionCookie('delta-session'),
    }));
    await connectSocketClient(socket);

    const deltaPromise = waitForSocketEvent(socket, socketServerEventTypes.gameStateDelta);
    const joinResult = await socket.timeout(1000).emitWithAck(socketClientEventTypes.joinGame, {
      gameId: GAME_ID,
      lastStateVersion: 1,
    });

    expect(joinResult).toEqual({
      ok: true,
      gameId: GAME_ID,
      teamId: TEAM_ONE_ID,
    });

    const deltaEvent = await deltaPromise;
    expect(deltaEvent).toMatchObject({
      gameId: GAME_ID,
      stateVersion: 2,
      fullSyncRequired: false,
    });
    expect(deltaEvent.events).toHaveLength(1);
    expect(deltaEvent.events[0]).toMatchObject({
      stateVersion: 2,
      eventType: eventTypes.resourceChanged,
    });
  });

  it('falls back to a full snapshot when the reconnect gap is too large', async () => {
    await seedGame({ stateVersion: MAX_DELTA_SYNC_GAP + 10 });
    await seedTeam();
    await seedPlayer({ teamId: TEAM_ONE_ID, sessionToken: 'full-sync-session' });
    app = await createRealtimeTestApp();
    baseUrl = await listenApp(app);

    const socket = trackSocket(createSocketClient({
      url: baseUrl,
      cookie: sessionCookie('full-sync-session'),
    }));
    await connectSocketClient(socket);

    const syncPromise = waitForSocketEvent(socket, socketServerEventTypes.gameStateSync);
    const joinResult = await socket.timeout(1000).emitWithAck(socketClientEventTypes.joinGame, {
      gameId: GAME_ID,
      lastStateVersion: 0,
    });

    expect(joinResult).toEqual({
      ok: true,
      gameId: GAME_ID,
      teamId: TEAM_ONE_ID,
    });

    const syncEvent = await syncPromise;
    expect(syncEvent).toMatchObject({
      gameId: GAME_ID,
      stateVersion: MAX_DELTA_SYNC_GAP + 10,
      snapshot: {
        game: { stateVersion: MAX_DELTA_SYNC_GAP + 10 },
      },
    });
  });

  it('joins and leaves game rooms and receives lifecycle broadcasts after REST commits', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ teamId: TEAM_ONE_ID, sessionToken: 'socket-session-one' });
    app = await createRealtimeTestApp();
    baseUrl = await listenApp(app);

    const socket = trackSocket(createSocketClient({
      url: baseUrl,
      cookie: sessionCookie('socket-session-one'),
    }));
    await connectSocketClient(socket);

    const joinResult = await socket.timeout(1000).emitWithAck(socketClientEventTypes.joinGame, {
      gameId: GAME_ID,
      lastStateVersion: 0,
    });
    expect(joinResult).toEqual({
      ok: true,
      gameId: GAME_ID,
      teamId: TEAM_ONE_ID,
    });

    const startedEventPromise = waitForSocketEvent(socket, socketServerEventTypes.gameStarted);
    const startResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/start`,
      headers: adminHeaders('socket-lifecycle-start'),
    });

    expect(startResponse.statusCode).toBe(200);
    const startedEvent = await startedEventPromise;
    expect(startedEvent).toMatchObject({
      gameId: GAME_ID,
      stateVersion: 1,
      game: {
        id: GAME_ID,
        status: 'active',
      },
    });
    expect(startedEvent.serverTime).toEqual(expect.any(String));

    const leaveResult = await socket.timeout(1000).emitWithAck(socketClientEventTypes.leaveGame, {
      gameId: GAME_ID,
    });
    expect(leaveResult).toEqual({
      ok: true,
      gameId: GAME_ID,
    });

    const noPauseEventPromise = expectNoSocketEvent(socket, socketServerEventTypes.gamePaused);
    const pauseResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/pause`,
      headers: adminHeaders('socket-lifecycle-pause'),
    });
    expect(pauseResponse.statusCode).toBe(200);

    await noPauseEventPromise;
  });

  it('broadcasts to team sub-rooms and filters snapshots per viewer', async () => {
    await seedGame();
    await seedTeam();
    await seedTeam({
      id: TEAM_TWO_ID,
      name: 'Blue Team',
      color: '#0000ff',
      joinCode: 'BLUE1234',
    });
    await seedPlayer({ teamId: TEAM_ONE_ID, sessionToken: 'team-one-session' });
    await seedPlayer({
      id: PLAYER_TWO_ID,
      teamId: TEAM_TWO_ID,
      sessionToken: 'team-two-session',
      displayName: 'Player Two',
    });

    const territoryHandler = createTerritoryModeHandler();
    const filteredTerritoryHandler: ModeHandler = {
      ...territoryHandler,
      filterStateForViewer(fullState, viewer) {
        return {
          ...fullState,
          game: {
            ...fullState.game,
            name: `visible-to-${viewer.playerId}`,
          },
        };
      },
    };

    app = await createRealtimeTestApp({
      modeRegistry: createModeRegistry([filteredTerritoryHandler]),
    });
    baseUrl = await listenApp(app);

    const firstSocket = trackSocket(createSocketClient({
      url: baseUrl,
      cookie: sessionCookie('team-one-session'),
    }));
    const secondSocket = trackSocket(createSocketClient({
      url: baseUrl,
      cookie: sessionCookie('team-two-session'),
    }));

    await connectSocketClient(firstSocket);
    await connectSocketClient(secondSocket);

    await firstSocket.timeout(1000).emitWithAck(socketClientEventTypes.joinGame, { gameId: GAME_ID });
    await secondSocket.timeout(1000).emitWithAck(socketClientEventTypes.joinGame, { gameId: GAME_ID });

    const [storedGame] = await testDatabase.db.select().from(games).where(eq(games.id, GAME_ID)).limit(1);
    const snapshot = {
      game: serializeGameRecord(storedGame),
      player: null,
      team: null,
      teams: [],
      players: [],
      teamLocations: [],
      zones: [],
      challenges: [],
      claims: [],
      annotations: [],
      teamResources: {},
    } satisfies GameStateSnapshot;

    const syncEventPromise = waitForSocketEvent(firstSocket, socketServerEventTypes.gameStateSync);
    const noSecondEventPromise = expectNoSocketEvent(secondSocket, socketServerEventTypes.gameStateSync);

    const sentCount = await app.broadcaster.send({
      gameId: GAME_ID,
      modeKey: 'territory',
      eventType: socketServerEventTypes.gameStateSync,
      stateVersion: 42,
      teamId: TEAM_ONE_ID,
      payload: {
        snapshot,
      },
    });

    expect(sentCount).toBe(1);

    const syncEvent = await syncEventPromise;
    expect(syncEvent).toMatchObject({
      gameId: GAME_ID,
      stateVersion: 42,
      snapshot: {
        game: {
          name: `visible-to-${PLAYER_ONE_ID}`,
        },
      },
    });
    expect(syncEvent.serverTime).toEqual(expect.any(String));

    await noSecondEventPromise;
  });

  async function createRealtimeTestApp(options: Partial<CreateTestAppOptions> = {}) {
    return createTestApp({
      db: testDatabase.db,
      adminToken: ADMIN_TOKEN,
      ...options,
    });
  }

  async function seedGame(overrides: Record<string, unknown> = {}) {
    const game = createTestGame(overrides);
    await testDatabase.db.insert(games).values(game);
    return game;
  }

  async function seedTeam(overrides: Record<string, unknown> = {}) {
    const team = createTestTeam({ gameId: GAME_ID, ...overrides });
    await testDatabase.db.insert(teams).values(team);
    return team;
  }

  async function seedPlayer(overrides: Record<string, unknown> = {}) {
    const player = createTestPlayer({ gameId: GAME_ID, id: PLAYER_ONE_ID, ...overrides });
    await testDatabase.db.insert(players).values(player);
    return player;
  }

  async function seedRealtimeEvents() {
    await logEvent(testDatabase.db, {
      gameId: GAME_ID,
      eventType: eventTypes.objectiveStateChanged,
      entityType: 'challenge',
      entityId: '55555555-5555-4555-8555-555555555555',
      actorType: 'system',
      afterState: { status: 'claimed' },
      meta: { source: 'socket-test' },
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

  async function listenApp(testApp: FastifyInstance): Promise<string> {
    return testApp.listen({ host: '127.0.0.1', port: 0 });
  }

  function trackSocket(socket: ReturnType<typeof createSocketClient>) {
    sockets.push(socket);
    return socket;
  }
});

function adminHeaders(idempotencyKey: string) {
  return {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    'idempotency-key': idempotencyKey,
  };
}

function sessionCookie(sessionToken: string) {
  return `${SESSION_COOKIE_NAME}=${sessionToken}`;
}

function waitForSocketEvent<TPayload = any>(socket: ReturnType<typeof createSocketClient>, eventName: string): Promise<TPayload> {
  return new Promise((resolve) => {
    socket.once(eventName, (payload: TPayload) => {
      resolve(payload);
    });
  });
}

async function expectNoSocketEvent(
  socket: ReturnType<typeof createSocketClient>,
  eventName: string,
  timeoutMs = 250,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, onEvent);
      resolve();
    }, timeoutMs);

    const onEvent = () => {
      clearTimeout(timer);
      socket.off(eventName, onEvent);
      reject(new Error(`Unexpected socket event: ${eventName}`));
    };

    socket.once(eventName, onEvent);
  });
}
