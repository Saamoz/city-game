import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import webPush from 'web-push';
import { games, players, teams } from '../db/schema.js';
import { createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';
import { combineNotifications, createNotificationService, type PushClient } from './notification-service.js';

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

  it('holds pushes inside the rate limit window and sends them as one when it ends', async () => {
    await seedBaseState({ pushSubscription: PUSH_SUBSCRIPTION });

    let currentTime = new Date('2026-04-01T12:00:00.000Z');
    const sent: Array<{ title: string; body: string; meta: unknown }> = [];
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const service = createNotificationService({
      db: testDatabase.db,
      pushClient: createPushClient({
        onSendNotification: async (_subscription, payload) => {
          sent.push(JSON.parse(String(payload)));
        },
      }),
      now: () => currentTime,
      rateLimitMs: 60_000,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return { cancel: () => undefined };
      },
      vapidPublicKey: 'test-public-key',
      vapidPrivateKey: 'test-private-key',
      vapidSubject: 'mailto:test@example.com',
    });
    const completed = (team: string, title: string) => service.sendTeamNotification({
      gameId: GAME_ID,
      teamId: TEAM_ID,
      title: 'Challenge completed',
      body: `${team} completed "${title}".`,
      batchTitle: '{count} challenges completed',
    });

    await completed('Gold Team', 'A');
    currentTime = new Date(currentTime.getTime() + 10_000);
    await completed('Red Team', 'B');
    await completed('Blue Team', 'C');
    await completed('Gold Team', 'D');
    await completed('Red Team', 'E');

    expect(sent.map((entry) => entry.title)).toEqual(['Challenge completed']);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(50_000);

    currentTime = new Date(currentTime.getTime() + 50_000);
    scheduled[0]?.callback();
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    expect(sent[1]).toMatchObject({
      title: '4 challenges completed',
      body: 'Red Team completed "B". Blue Team completed "C". Gold Team completed "D". +1 more.',
      meta: { batched: true, count: 4 },
    });

    // The window restarts from the combined push.
    currentTime = new Date(currentTime.getTime() + 61_000);
    await completed('Blue Team', 'F');
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ title: 'Challenge completed', body: 'Blue Team completed "F".' });
  });

  it('sends a single held push unchanged and names mixed batches generically', () => {
    const item = (title: string, batchTitle: string | null, priority: 'high' | 'medium' = 'medium') => ({
      priority,
      batchTitle,
      payload: { title, body: title + '.', priority, gameId: GAME_ID, teamId: TEAM_ID, meta: {} },
    });

    expect(combineNotifications([item('Zone captured', '{count} zone captures')]).payload.title).toBe('Zone captured');
    const mixed = combineNotifications([item('Zone captured', '{count} zone captures'), item('Claim expiring soon', null, 'high')]);
    expect(mixed.payload).toMatchObject({ title: '2 game updates', body: 'Zone captured. Claim expiring soon.', priority: 'high' });
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

  it('keeps sending to the rest of the team and logs when one push fails', async () => {
    await seedBaseState({ pushSubscription: { ...PUSH_SUBSCRIPTION, endpoint: 'https://web.push.apple.com/broken' } });
    await testDatabase.db.insert(players).values(createTestPlayer({
      id: '44444444-4444-4444-8444-444444444444',
      displayName: 'Teammate',
      pushSubscription: PUSH_SUBSCRIPTION,
    }));
    const delivered: string[] = [];
    const logger = { info: vi.fn(), warn: vi.fn() };

    const service = createNotificationService({
      db: testDatabase.db,
      logger,
      pushClient: createPushClient({
        onSendNotification: async (subscription) => {
          if (subscription.endpoint.endsWith('/broken')) {
            throw Object.assign(new Error('Forbidden'), { statusCode: 403, body: '{"reason":"BadJwtToken"}' });
          }
          delivered.push(subscription.endpoint);
        },
      }),
      vapidPublicKey: 'test-public-key',
      vapidPrivateKey: 'test-private-key',
      vapidSubject: 'mailto:test@example.com',
    });

    await expect(service.sendTeamNotification({
      gameId: GAME_ID,
      teamId: TEAM_ID,
      title: 'Zone captured',
      body: 'Your team captured Downtown Zone.',
    })).resolves.toBeUndefined();

    expect(delivered).toEqual([PUSH_SUBSCRIPTION.endpoint]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, responseBody: '{"reason":"BadJwtToken"}', endpointHost: 'web.push.apple.com' }),
      'push notification failed',
    );
  });

  it('configures the real web-push client with valid VAPID details', () => {
    // Guards the web-push import: the namespace import left setVapidDetails undefined under Node ESM,
    // which silently disabled every push in production.
    const logger = { info: vi.fn(), warn: vi.fn() };
    const keys = webPush.generateVAPIDKeys();
    createNotificationService({
      db: testDatabase.db,
      logger,
      vapidPublicKey: keys.publicKey,
      vapidPrivateKey: keys.privateKey,
      vapidSubject: 'mailto:test@example.com',
    });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('skips the excluded player', async () => {
    await seedBaseState({ pushSubscription: { ...PUSH_SUBSCRIPTION, endpoint: 'https://push.example/actor' } });
    await testDatabase.db.insert(players).values(createTestPlayer({
      id: '44444444-4444-4444-8444-444444444444',
      displayName: 'Teammate',
      pushSubscription: PUSH_SUBSCRIPTION,
    }));
    const delivered: string[] = [];

    const service = createNotificationService({
      db: testDatabase.db,
      pushClient: createPushClient({ onSendNotification: async (subscription) => { delivered.push(subscription.endpoint); } }),
      vapidPublicKey: 'test-public-key',
      vapidPrivateKey: 'test-private-key',
      vapidSubject: 'mailto:test@example.com',
    });

    await service.sendTeamNotification({
      gameId: GAME_ID,
      teamId: TEAM_ID,
      excludePlayerId: PLAYER_ID,
      title: 'Challenge completed',
      body: 'Sam completed "Bean selfie".',
    });

    expect(delivered).toEqual([PUSH_SUBSCRIPTION.endpoint]);
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
