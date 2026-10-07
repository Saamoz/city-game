import { and, eq, isNotNull, ne } from 'drizzle-orm';
import type { PushSubscription as WebPushSubscription, RequestOptions } from 'web-push';
// web-push is CommonJS: under Node ESM its functions only exist on the default export.
import webPush from 'web-push';
import type { GameSettings, JsonObject, PushSubscriptionData } from '@city-game/shared';
import { games, players } from '../db/schema.js';
import type { DatabaseClient } from '../db/connection.js';
import { env } from '../db/env.js';

export interface TeamNotificationInput {
  gameId: string;
  teamId: string;
  title: string;
  body: string;
  priority?: 'high' | 'medium' | 'low';
  meta?: JsonObject;
  // Skip this player, e.g. the one whose action caused the notification.
  excludePlayerId?: string;
  // Title for a combined push when several of these are held back together, with {count} filled in,
  // e.g. '{count} challenges completed'. Mixed batches fall back to '{count} game updates'.
  batchTitle?: string;
}

export interface NotificationService {
  sendTeamNotification(input: TeamNotificationInput): Promise<void>;
  // Cancels pending batched pushes; called when the server shuts down.
  close?(): void;
}

export type NotificationScheduler = (callback: () => void, delayMs: number) => { cancel(): void };

export interface PushClient {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: WebPushSubscription,
    payload?: string | Buffer | null,
    options?: RequestOptions,
  ): Promise<unknown>;
}

export interface NotificationLogger {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
}

export interface NotificationServiceOptions {
  db: DatabaseClient;
  logger?: NotificationLogger;
  pushClient?: PushClient;
  now?: () => Date;
  rateLimitMs?: number;
  schedule?: NotificationScheduler;
  vapidPublicKey?: string | null;
  vapidPrivateKey?: string | null;
  vapidSubject?: string | null;
}

export function createNotificationService(options: NotificationServiceOptions): NotificationService {
  const pushClient = options.pushClient ?? webPush;
  const now = options.now ?? (() => new Date());
  const rateLimitMs = options.rateLimitMs ?? env.pushRateLimitMs;
  const vapidPublicKey = options.vapidPublicKey ?? env.vapidPublicKey;
  const vapidPrivateKey = options.vapidPrivateKey ?? env.vapidPrivateKey;
  const vapidSubject = options.vapidSubject ?? env.vapidSubject;
  const schedule = options.schedule ?? defaultScheduler;
  let isConfigured = Boolean(vapidPublicKey && vapidPrivateKey && vapidSubject);
  // Each player gets at most one push per rateLimitMs. Pushes inside the window are held and sent
  // together as one when it ends, instead of being dropped.
  const lastSentAtByPlayerId = new Map<string, number>();
  const pendingByPlayerId = new Map<string, PendingBatch>();

  if (isConfigured) {
    try {
      pushClient.setVapidDetails(vapidSubject!, vapidPublicKey!, vapidPrivateKey!);
    } catch (error) {
      isConfigured = false;
      options.logger?.warn({ err: error }, 'push notifications disabled: invalid VAPID details');
    }
  } else {
    options.logger?.info({
      hasPublicKey: Boolean(vapidPublicKey),
      hasPrivateKey: Boolean(vapidPrivateKey),
      hasSubject: Boolean(vapidSubject),
    }, 'push notifications disabled: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must all be set');
  }

  async function deliver(playerId: string, subscription: WebPushSubscription, notification: QueuedNotification): Promise<void> {
    try {
      await pushClient.sendNotification(subscription, JSON.stringify(notification.payload), {
        TTL: 60,
        urgency: mapUrgency(notification.priority),
      });
    } catch (error) {
      if (isInvalidSubscriptionError(error)) {
        await clearPlayerSubscription(options.db, playerId);
        lastSentAtByPlayerId.delete(playerId);
        pendingByPlayerId.get(playerId)?.timer.cancel();
        pendingByPlayerId.delete(playerId);
        return;
      }

      // A push is best-effort: one failing device must not stop the rest of the team, or the
      // caller's work after it (win checks, claim expiry).
      options.logger?.warn({
        playerId,
        statusCode: getErrorField(error, 'statusCode'),
        responseBody: getErrorField(error, 'body'),
        endpointHost: getEndpointHost(subscription.endpoint),
        err: error,
      }, 'push notification failed');
    }
  }

  async function flush(playerId: string): Promise<void> {
    const batch = pendingByPlayerId.get(playerId);
    pendingByPlayerId.delete(playerId);
    if (!batch || batch.items.length === 0) {
      return;
    }

    lastSentAtByPlayerId.set(playerId, now().getTime());
    await deliver(playerId, batch.subscription, combineNotifications(batch.items));
  }

  return {
    async sendTeamNotification(input) {
      if (!isConfigured) {
        return;
      }

      const [game] = await options.db
        .select({ settings: games.settings })
        .from(games)
        .where(eq(games.id, input.gameId))
        .limit(1);

      if (!game) {
        return;
      }

      const gameSettings = (game.settings ?? {}) as GameSettings;
      if (gameSettings.notification_config?.enabled === false) {
        return;
      }

      const subscribedPlayers = await options.db
        .select({
          id: players.id,
          pushSubscription: players.pushSubscription,
        })
        .from(players)
        .where(
          and(
            eq(players.gameId, input.gameId),
            eq(players.teamId, input.teamId),
            isNotNull(players.pushSubscription),
            input.excludePlayerId ? ne(players.id, input.excludePlayerId) : undefined,
          ),
        );

      const notification: QueuedNotification = {
        priority: input.priority ?? 'medium',
        batchTitle: input.batchTitle ?? null,
        payload: {
          title: input.title,
          body: input.body,
          priority: input.priority ?? 'medium',
          gameId: input.gameId,
          teamId: input.teamId,
          meta: input.meta ?? {},
        },
      };

      for (const player of subscribedPlayers) {
        const subscription = normalizePushSubscription(player.pushSubscription);
        if (!subscription) {
          await clearPlayerSubscription(options.db, player.id);
          lastSentAtByPlayerId.delete(player.id);
          continue;
        }

        const pending = pendingByPlayerId.get(player.id);
        if (pending) {
          pending.items.push(notification);
          pending.subscription = subscription;
          continue;
        }

        const currentTime = now().getTime();
        const sentAt = lastSentAtByPlayerId.get(player.id);
        if (sentAt !== undefined && currentTime - sentAt < rateLimitMs) {
          const playerId = player.id;
          pendingByPlayerId.set(playerId, {
            subscription,
            items: [notification],
            timer: schedule(() => {
              void flush(playerId).catch((error) => {
                options.logger?.warn({ playerId, err: error }, 'batched push notification failed');
              });
            }, sentAt + rateLimitMs - currentTime),
          });
          continue;
        }

        lastSentAtByPlayerId.set(player.id, currentTime);
        await deliver(player.id, subscription, notification);
      }
    },
    close() {
      for (const batch of pendingByPlayerId.values()) {
        batch.timer.cancel();
      }
      pendingByPlayerId.clear();
    },
  };
}

interface QueuedNotification {
  priority: NonNullable<TeamNotificationInput['priority']>;
  batchTitle: string | null;
  payload: {
    title: string;
    body: string;
    priority: string;
    gameId: string;
    teamId: string;
    meta: JsonObject;
  };
}

interface PendingBatch {
  subscription: WebPushSubscription;
  items: QueuedNotification[];
  timer: { cancel(): void };
}

const MAX_BATCH_LINES = 3;
const PRIORITY_RANK = { low: 0, medium: 1, high: 2 } as const;

export function combineNotifications(items: QueuedNotification[]): QueuedNotification {
  const [first] = items;
  if (!first) {
    throw new Error('Cannot combine an empty batch.');
  }

  if (items.length === 1) {
    return first;
  }

  const count = items.length;
  const sharedBatchTitle = items.every((item) => item.batchTitle === first.batchTitle) ? first.batchTitle : null;
  const title = (sharedBatchTitle ?? '{count} game updates').replace('{count}', String(count));
  const lines = items.slice(0, MAX_BATCH_LINES).map((item) => item.payload.body);
  const remaining = count - lines.length;
  const body = lines.join(' ') + (remaining > 0 ? ` +${remaining} more.` : '');
  const priority = items.reduce<QueuedNotification['priority']>(
    (highest, item) => (PRIORITY_RANK[item.priority] > PRIORITY_RANK[highest] ? item.priority : highest),
    'low',
  );

  return {
    priority,
    batchTitle: sharedBatchTitle,
    payload: {
      ...first.payload,
      title,
      body,
      priority,
      meta: { batched: true, count },
    },
  };
}

function defaultScheduler(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, Math.max(0, delayMs));
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

export async function clearPlayerSubscription(db: DatabaseClient, playerId: string): Promise<void> {
  await db.update(players).set({ pushSubscription: null }).where(eq(players.id, playerId));
}

export async function clearTeamSubscriptions(db: DatabaseClient, gameId: string, teamId: string): Promise<number> {
  const cleared = await db
    .update(players)
    .set({ pushSubscription: null })
    .where(and(eq(players.gameId, gameId), eq(players.teamId, teamId), isNotNull(players.pushSubscription)))
    .returning({ id: players.id });

  return cleared.length;
}

function normalizePushSubscription(value: unknown): WebPushSubscription | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const subscription = value as PushSubscriptionData;
  if (
    typeof subscription.endpoint !== 'string'
    || !subscription.endpoint
    || !subscription.keys
    || typeof subscription.keys.p256dh !== 'string'
    || typeof subscription.keys.auth !== 'string'
  ) {
    return null;
  }

  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
  };
}

function mapUrgency(priority: TeamNotificationInput['priority']): RequestOptions['urgency'] {
  switch (priority) {
    case 'high':
      return 'high';
    case 'low':
      return 'low';
    default:
      return 'normal';
  }
}

function getErrorField(error: unknown, field: string): unknown {
  return error && typeof error === 'object' && field in error ? (error as Record<string, unknown>)[field] : undefined;
}

function getEndpointHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

function isInvalidSubscriptionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const statusCode = 'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : Number.NaN;
  return statusCode === 404 || statusCode === 410;
}
