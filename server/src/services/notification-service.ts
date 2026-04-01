import { and, eq, isNotNull } from 'drizzle-orm';
import type { PushSubscription as WebPushSubscription, RequestOptions } from 'web-push';
import * as webPush from 'web-push';
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

export interface NotificationServiceOptions {
  db: DatabaseClient;
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
    } catch {
      isConfigured = false;
    }
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

          throw error;
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

function isInvalidSubscriptionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const statusCode = 'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : Number.NaN;
  return statusCode === 404 || statusCode === 410;
}
