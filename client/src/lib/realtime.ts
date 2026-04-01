import {
  socketClientEventTypes,
  socketServerEventTypes,
  type SocketEventPayloadMap,
  type SocketServerEventType,
} from '@city-game/shared';
import { io, type Socket } from 'socket.io-client';

export type GameRealtimeSocket = Socket;

export const directRealtimeEventTypes = [
  socketServerEventTypes.gameStarted,
  socketServerEventTypes.gamePaused,
  socketServerEventTypes.gameResumed,
  socketServerEventTypes.gameEnded,
  socketServerEventTypes.playerJoined,
  socketServerEventTypes.annotationAdded,
  socketServerEventTypes.annotationRemoved,
  socketServerEventTypes.resourceChanged,
  socketServerEventTypes.zoneCaptured,
  socketServerEventTypes.challengeClaimed,
  socketServerEventTypes.challengeCompleted,
  socketServerEventTypes.challengeReleased,
  socketServerEventTypes.challengeSpawned,
] as const;

export function createRealtimeSocket(): GameRealtimeSocket {
  return io({
    path: '/socket.io',
    withCredentials: true,
    autoConnect: false,
    reconnection: true,
  });
}

export function joinRealtimeGame(
  socket: GameRealtimeSocket,
  gameId: string,
  lastStateVersion?: number,
  ack?: (response: unknown) => void,
): void {
  socket.emit(socketClientEventTypes.joinGame, { gameId, lastStateVersion }, ack);
}

export function leaveRealtimeGame(
  socket: GameRealtimeSocket,
  gameId: string,
  ack?: (response: unknown) => void,
): void {
  socket.emit(socketClientEventTypes.leaveGame, { gameId }, ack);
}

export function buildRealtimePayloadKey(
  eventType: SocketServerEventType,
  payload: SocketEventPayloadMap[SocketServerEventType],
): string {
  switch (eventType) {
    case socketServerEventTypes.gameStarted:
    case socketServerEventTypes.gamePaused:
    case socketServerEventTypes.gameResumed:
    case socketServerEventTypes.gameEnded: {
      const lifecyclePayload = payload as SocketEventPayloadMap['game_started'];
      return `game:${lifecyclePayload.game.id}`;
    }
    case socketServerEventTypes.playerJoined: {
      const joinedPayload = payload as SocketEventPayloadMap['player_joined'];
      return `player:${joinedPayload.player.id}`;
    }
    case socketServerEventTypes.annotationAdded: {
      const annotationPayload = payload as SocketEventPayloadMap['annotation_added'];
      return `annotation:${annotationPayload.annotation.id}`;
    }
    case socketServerEventTypes.annotationRemoved: {
      const removedPayload = payload as SocketEventPayloadMap['annotation_removed'];
      return `annotation:${removedPayload.annotationId}`;
    }
    case socketServerEventTypes.resourceChanged: {
      const resourcePayload = payload as SocketEventPayloadMap['resource_changed'];
      return `resource:${resourcePayload.entry.id}`;
    }
    case socketServerEventTypes.zoneCaptured: {
      const zonePayload = payload as SocketEventPayloadMap['zone_captured'];
      return `zone:${zonePayload.zone.id}:claim:${zonePayload.claim.id}`;
    }
    case socketServerEventTypes.challengeClaimed: {
      const claimedPayload = payload as SocketEventPayloadMap['challenge_claimed'];
      return `claim:${claimedPayload.claim.id}:challenge:${claimedPayload.challenge.id}`;
    }
    case socketServerEventTypes.challengeCompleted: {
      const completedPayload = payload as SocketEventPayloadMap['challenge_completed'];
      return `claim:${completedPayload.claim.id}:challenge:${completedPayload.challenge.id}`;
    }
    case socketServerEventTypes.challengeReleased: {
      const releasedPayload = payload as SocketEventPayloadMap['challenge_released'];
      return `claim:${releasedPayload.claim.id}:challenge:${releasedPayload.challenge.id}`;
    }
    case socketServerEventTypes.challengeSpawned: {
      const spawnedPayload = payload as SocketEventPayloadMap['challenge_spawned'];
      return `challenge:${spawnedPayload.challenge.id}`;
    }
    case socketServerEventTypes.gameStateSync: {
      const syncPayload = payload as SocketEventPayloadMap['game_state_sync'];
      return `sync:${syncPayload.stateVersion}`;
    }
    case socketServerEventTypes.gameStateDelta: {
      const deltaPayload = payload as SocketEventPayloadMap['game_state_delta'];
      return `delta:${deltaPayload.stateVersion}`;
    }
    default:
      return `${eventType}:${payload.stateVersion}`;
  }
}
