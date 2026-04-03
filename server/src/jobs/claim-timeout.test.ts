import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { eventTypes, socketServerEventTypes } from '@city-game/shared';
import { buildApp } from '../app.js';
import { challengeClaims, challenges, gameEvents, games, players, teams } from '../db/schema.js';
import { createModeRegistry } from '../modes/index.js';
import { createZone } from '../services/spatial-service.js';
import type { NotificationService, TeamNotificationInput } from '../services/notification-service.js';
import { createTestChallenge, createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { runClaimTimeoutSweep, startClaimTimeoutJob } from './claim-timeout.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';
const CHALLENGE_ID = '55555555-5555-4555-8555-555555555555';
const CLAIM_ID = '77777777-7777-4777-8777-777777777777';
const NOW = new Date('2026-04-01T12:00:00.000Z');

const ZONE_GEOMETRY = {
  type: 'Polygon',
  coordinates: [[
    [-97.1405, 49.8944],
    [-97.1363, 49.8944],
    [-97.1363, 49.8962],
    [-97.1405, 49.8962],
    [-97.1405, 49.8944],
  ]],
} as unknown as import('@city-game/shared').GeoJsonPolygon;

describe('claim timeout job', () => {
  let app: FastifyInstance | undefined;
  let testDatabase: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    testDatabase = await getTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('expires stale active claims, logs events, and broadcasts release updates', async () => {
    const notifications: TeamNotificationInput[] = [];
    const broadcasts: Array<Record<string, unknown>> = [];
    await seedBaseState();
    await seedClaimedChallenge({ expiresAt: new Date(NOW.getTime() - 60_000) });

    const result = await runClaimTimeoutSweep({
      db: testDatabase.db,
      broadcaster: {
        send: async (input) => {
          broadcasts.push(input as unknown as Record<string, unknown>);
          return 1;
        },
      },
      modeRegistry: createModeRegistry(),
      notificationService: notificationRecorder(notifications),
      now: NOW,
    });

    expect(result).toEqual({
      expiredClaims: 1,
      warningNotifications: 0,
    });

    const [storedChallenge] = await testDatabase.db.select().from(challenges).where(eq(challenges.id, CHALLENGE_ID));
    expect(storedChallenge?.status).toBe('available');
    expect(storedChallenge?.currentClaimId).toBeNull();
    expect(storedChallenge?.expiresAt).toBeNull();

    const [storedClaim] = await testDatabase.db.select().from(challengeClaims).where(eq(challengeClaims.id, CLAIM_ID));
    expect(storedClaim?.status).toBe('expired');
    expect(storedClaim?.releasedAt?.toISOString()).toBe(NOW.toISOString());

    const [storedGame] = await testDatabase.db
      .select({ stateVersion: games.stateVersion })
      .from(games)
      .where(eq(games.id, GAME_ID));
    expect(storedGame?.stateVersion).toBe(1);

    const storedEvents = await testDatabase.db
      .select({ eventType: gameEvents.eventType, stateVersion: gameEvents.stateVersion })
      .from(gameEvents)
      .where(eq(gameEvents.gameId, GAME_ID))
      .orderBy(asc(gameEvents.createdAt));
    expect(storedEvents.map((event) => event.eventType).sort()).toEqual([
      eventTypes.challengeReleased,
      eventTypes.objectiveStateChanged,
    ].sort());
    expect(storedEvents.map((event) => event.stateVersion)).toEqual([1, 1]);

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      gameId: GAME_ID,
      modeKey: 'territory',
      eventType: socketServerEventTypes.challengeReleased,
      stateVersion: 1,
      payload: {
        challenge: { id: CHALLENGE_ID, status: 'available' },
        claim: { id: CLAIM_ID, status: 'expired' },
      },
    });
    expect(notifications).toEqual([]);
  });

  it('clears the temporary zone assignment when a portable claim expires', async () => {
    const notifications: TeamNotificationInput[] = [];
    const broadcasts: Array<Record<string, unknown>> = [];
    await seedBaseState();
    await seedClaimedChallenge({ expiresAt: new Date(NOW.getTime() - 60_000), config: { portable: true } });

    const result = await runClaimTimeoutSweep({
      db: testDatabase.db,
      broadcaster: {
        send: async (input) => {
          broadcasts.push(input as unknown as Record<string, unknown>);
          return 1;
        },
      },
      modeRegistry: createModeRegistry(),
      notificationService: notificationRecorder(notifications),
      now: NOW,
    });

    expect(result.expiredClaims).toBe(1);

    const [storedChallenge] = await testDatabase.db.select().from(challenges).where(eq(challenges.id, CHALLENGE_ID));
    expect(storedChallenge?.zoneId).toBeNull();
    expect(broadcasts).toHaveLength(1);
  });


  it('sends pre-expiry warnings and marks warningSent without changing authoritative state', async () => {
    const notifications: TeamNotificationInput[] = [];
    const broadcasts: Array<Record<string, unknown>> = [];
    await seedBaseState();
    await seedClaimedChallenge({
      expiresAt: new Date(NOW.getTime() + 90_000),
      warningSent: false,
    });

    const result = await runClaimTimeoutSweep({
      db: testDatabase.db,
      broadcaster: {
        send: async (input) => {
          broadcasts.push(input as unknown as Record<string, unknown>);
          return 1;
        },
      },
      modeRegistry: createModeRegistry(),
      notificationService: notificationRecorder(notifications),
      now: NOW,
    });

    expect(result).toEqual({
      expiredClaims: 0,
      warningNotifications: 1,
    });

    const [storedClaim] = await testDatabase.db.select().from(challengeClaims).where(eq(challengeClaims.id, CLAIM_ID));
    expect(storedClaim?.warningSent).toBe(true);
    expect(storedClaim?.status).toBe('active');

    const [storedGame] = await testDatabase.db
      .select({ stateVersion: games.stateVersion })
      .from(games)
      .where(eq(games.id, GAME_ID));
    expect(storedGame?.stateVersion).toBe(0);

    const storedEvents = await testDatabase.db.select().from(gameEvents).where(eq(gameEvents.gameId, GAME_ID));
    expect(storedEvents).toHaveLength(0);
    expect(broadcasts).toEqual([]);
    expect(notifications).toEqual([
      {
        gameId: GAME_ID,
        teamId: TEAM_ID,
        title: 'Claim expiring soon',
        body: 'Your claim is about to expire!',
        priority: 'high',
        meta: {
          claimId: CLAIM_ID,
          challengeId: CHALLENGE_ID,
          expiresAt: new Date(NOW.getTime() + 90_000).toISOString(),
        },
      },
    ]);
  });

  it('runs an immediate startup sweep so already-expired claims are recovered on boot', async () => {
    const notifications: TeamNotificationInput[] = [];
    const broadcasts: Array<Record<string, unknown>> = [];
    await seedBaseState();
    await seedClaimedChallenge({ expiresAt: new Date(NOW.getTime() - 60_000) });

    app = buildApp({
      db: testDatabase.db,
      notificationService: notificationRecorder(notifications),
    });

    app.broadcaster.send = async (input) => {
      broadcasts.push(input as unknown as Record<string, unknown>);
      return 1;
    };

    const controller = startClaimTimeoutJob(app, {
      intervalMs: 60_000,
      now: () => NOW,
    });

    await app.ready();
    await waitFor(async () => {
      const [storedClaim] = await testDatabase.db.select().from(challengeClaims).where(eq(challengeClaims.id, CLAIM_ID));
      return storedClaim?.status === 'expired';
    });

    controller.stop();

    const [storedClaim] = await testDatabase.db.select().from(challengeClaims).where(eq(challengeClaims.id, CLAIM_ID));
    expect(storedClaim?.status).toBe('expired');
    expect(broadcasts).toHaveLength(1);
  });

  async function seedBaseState() {
    await testDatabase.db.insert(games).values(createTestGame({ status: 'active' }));
    await testDatabase.db.insert(teams).values(createTestTeam());
    await testDatabase.db.insert(players).values(createTestPlayer({ id: PLAYER_ID }));
  }

  async function seedClaimedChallenge(input: { expiresAt: Date; warningSent?: boolean; config?: Record<string, unknown> }) {
    const zone = await createZone(testDatabase.db, {
      gameId: GAME_ID,
      name: 'Downtown Zone',
      geometry: ZONE_GEOMETRY,
      pointValue: 1,
    });

    await testDatabase.db.insert(challenges).values(createTestChallenge({
      id: CHALLENGE_ID,
      gameId: GAME_ID,
      zoneId: zone.id,
      status: 'available',
      config: input.config ?? {},
    }));

    await testDatabase.db.insert(challengeClaims).values({
      id: CLAIM_ID,
      challengeId: CHALLENGE_ID,
      gameId: GAME_ID,
      teamId: TEAM_ID,
      playerId: PLAYER_ID,
      status: 'active',
      expiresAt: input.expiresAt,
      warningSent: input.warningSent ?? false,
      locationAtClaim: sql`ST_SetSRID(ST_MakePoint(${-97.1384}, ${49.8951}), 4326)`,
    });

    await testDatabase.db
      .update(challenges)
      .set({
        status: 'claimed',
        currentClaimId: CLAIM_ID,
        expiresAt: input.expiresAt,
      })
      .where(eq(challenges.id, CHALLENGE_ID));
  }
});

function notificationRecorder(collected: TeamNotificationInput[]): NotificationService {
  return {
    async sendTeamNotification(input) {
      collected.push(input);
    },
  };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error('Timed out waiting for claim-timeout job to complete.');
}
