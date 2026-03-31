import type { JsonObject } from '@city-game/shared';

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

export function createNotificationService(): NotificationService {
  return {
    async sendTeamNotification() {
      return;
    },
  };
}
