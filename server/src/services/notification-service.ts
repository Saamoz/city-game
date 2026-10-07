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
}

export interface NotificationService {
  sendTeamNotification(input: TeamNotificationInput): Promise<void>;
}

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
  let isConfigured = Boolean(vapidPublicKey && vapidPrivateKey && vapidSubject);
  const lastSentAtByPlayerId = new Map<string, number>();

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

      const payload = JSON.stringify({
        title: input.title,
        body: input.body,
        priority: input.priority ?? 'medium',
        gameId: input.gameId,
        teamId: input.teamId,
        meta: input.meta ?? {},
      });

      for (const player of subscribedPlayers) {
        const subscription = normalizePushSubscription(player.pushSubscription);
        if (!subscription) {
          await clearPlayerSubscription(options.db, player.id);
          lastSentAtByPlayerId.delete(player.id);
          continue;
        }

        const sentAt = lastSentAtByPlayerId.get(player.id) ?? 0;
        const currentTime = now().getTime();
        if (currentTime - sentAt < rateLimitMs) {
          continue;
        }

        try {
          await pushClient.sendNotification(subscription, payload, {
            TTL: 60,
            urgency: mapUrgency(input.priority),
          });
          lastSentAtByPlayerId.set(player.id, currentTime);
        } catch (error) {
          if (isInvalidSubscriptionError(error)) {
            await clearPlayerSubscription(options.db, player.id);
            lastSentAtByPlayerId.delete(player.id);
            continue;
          }

          // A push is best-effort: one failing device must not stop the rest of the team, or the
          // caller's work after it (win checks, claim expiry).
          options.logger?.warn({
            playerId: player.id,
            statusCode: getErrorField(error, 'statusCode'),
            responseBody: getErrorField(error, 'body'),
            endpointHost: getEndpointHost(subscription.endpoint),
            err: error,
          }, 'push notification failed');
        }
      }
    },
  };
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
