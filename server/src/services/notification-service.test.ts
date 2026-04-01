import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { games, players, teams } from '../db/schema.js';
import { createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { createNotificationService, type PushClient } from './notification-service.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';

const PUSH_SUBSCRIPTION = {
  endpoint: 'https://push.example/subscriptions/test-player',
  expirationTime: null,
  keys: {
    p256dh: 'test-p256dh-key',
    auth: 'test-auth-key',
  },
} as const;

describe('notification service', () => {
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

  it('sends web push notifications to subscribed team members', async () => {
    await seedBaseState({ pushSubscription: PUSH_SUBSCRIPTION });

    const vapidCalls: Array<{ subject: string; publicKey: string; privateKey: string }> = [];
    const sentNotifications: Array<{ payload: string | Buffer | null | undefined; options: unknown }> = [];
    const service = createNotificationService({
      db: testDatabase.db,
      pushClient: createPushClient({
        onSetVapidDetails: (subject, publicKey, privateKey) => {
          vapidCalls.push({ subject, publicKey, privateKey });
        },
        onSendNotification: async (_subscription, payload, options) => {
          sentNotifications.push({ payload, options });
        },
      }),
      vapidPublicKey: 'test-public-key',
      vapidPrivateKey: 'test-private-key',
      vapidSubject: 'mailto:test@example.com',
    });

    await service.sendTeamNotification({
      gameId: GAME_ID,
      teamId: TEAM_ID,
      title: 'Zone captured',
      body: 'Your team captured Downtown Zone.',
      priority: 'high',
      meta: {
        zoneId: '44444444-4444-4444-8444-444444444444',
      },
    });

    expect(vapidCalls).toEqual([
      {
        subject: 'mailto:test@example.com',
        publicKey: 'test-public-key',
        privateKey: 'test-private-key',
      },
    ]);
    expect(sentNotifications).toHaveLength(1);
    expect(JSON.parse(String(sentNotifications[0]?.payload))).toEqual({
      title: 'Zone captured',
      body: 'Your team captured Downtown Zone.',
      priority: 'high',
      gameId: GAME_ID,
      teamId: TEAM_ID,
      meta: {
        zoneId: '44444444-4444-4444-8444-444444444444',
      },
    });
    expect(sentNotifications[0]?.options).toMatchObject({
      TTL: 60,
      urgency: 'high',
    });
  });

  it('rate limits repeat pushes for the same player within the configured window', async () => {
    await seedBaseState({ pushSubscription: PUSH_SUBSCRIPTION });

    let currentTime = new Date('2026-04-01T12:00:00.000Z');
    const sentNotifications: Array<string> = [];
    const service = createNotificationService({
      db: testDatabase.db,
      pushClient: createPushClient({
        onSendNotification: async (_subscription, payload) => {
          sentNotifications.push(String(payload));
        },
      }),
      now: () => currentTime,
      rateLimitMs: 60_000,
      vapidPublicKey: 'test-public-key',
      vapidPrivateKey: 'test-private-key',
      vapidSubject: 'mailto:test@example.com',
    });

    await service.sendTeamNotification({
      gameId: GAME_ID,
      teamId: TEAM_ID,
      title: 'Claim expiring soon',
      body: 'Your claim is about to expire!',
      priority: 'high',
    });
    await service.sendTeamNotification({
      gameId: GAME_ID,
      teamId: TEAM_ID,
      title: 'Claim expiring soon',
      body: 'Your claim is about to expire!',
      priority: 'high',
    });

    currentTime = new Date(currentTime.getTime() + 61_000);

    await service.sendTeamNotification({
      gameId: GAME_ID,
      teamId: TEAM_ID,
      title: 'Claim expiring soon',
      body: 'Your claim is about to expire!',
      priority: 'high',
    });

    expect(sentNotifications).toHaveLength(2);
  });

  it('clears invalid subscriptions after a 410 push response', async () => {
    await seedBaseState({ pushSubscription: PUSH_SUBSCRIPTION });

    const service = createNotificationService({
      db: testDatabase.db,
      pushClient: createPushClient({
        onSendNotification: async () => {
          throw Object.assign(new Error('Gone'), { statusCode: 410 });
        },
      }),
      vapidPublicKey: 'test-public-key',
      vapidPrivateKey: 'test-private-key',
      vapidSubject: 'mailto:test@example.com',
    });

    await service.sendTeamNotification({
      gameId: GAME_ID,
      teamId: TEAM_ID,
      title: 'Zone captured',
      body: 'Your team captured Downtown Zone.',
      priority: 'high',
    });

    const [storedPlayer] = await testDatabase.db
      .select({ pushSubscription: players.pushSubscription })
      .from(players)
      .where(eq(players.id, PLAYER_ID))
      .limit(1);

    expect(storedPlayer?.pushSubscription).toBeNull();
  });

  async function seedBaseState(playerOverrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(games).values(createTestGame());
    await testDatabase.db.insert(teams).values(createTestTeam());
    await testDatabase.db.insert(players).values(createTestPlayer({ id: PLAYER_ID, ...playerOverrides }));
  }
});

function createPushClient(input: {
  onSetVapidDetails?: (subject: string, publicKey: string, privateKey: string) => void;
  onSendNotification?: PushClient['sendNotification'];
}): PushClient {
  return {
    setVapidDetails(subject, publicKey, privateKey) {
      input.onSetVapidDetails?.(subject, publicKey, privateKey);
    },
    async sendNotification(subscription, payload, options) {
      await input.onSendNotification?.(subscription, payload, options);
      return undefined;
    },
  };
}
