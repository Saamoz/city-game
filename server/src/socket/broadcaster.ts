import type { GameStateSnapshot, SocketServerEventType } from '@city-game/shared';
import type { Server, Socket } from 'socket.io';
import type { ModeRegistry } from '../modes/index.js';
import { getGameRoom, getTeamRoom } from './rooms.js';

export interface RealtimePlayerIdentity {
  id: string;
  gameId: string;
  teamId: string | null;
}

export interface RealtimeSocketData {
  sessionToken: string;
  player: RealtimePlayerIdentity;
  joinedGameId: string | null;
}

export type RealtimeSocket = Socket<any, any, any, RealtimeSocketData>;
export type RealtimeServer = Server<any, any, any, RealtimeSocketData>;

export interface BroadcastInput<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  gameId: string;
  modeKey: string;
  eventType: SocketServerEventType;
  stateVersion: number;
  payload: TPayload;
  teamId?: string;
}

export class Broadcaster {
  constructor(
    private readonly io: RealtimeServer,
    private readonly registry: ModeRegistry,
  ) {}

  async send<TPayload extends Record<string, unknown>>(input: BroadcastInput<TPayload>): Promise<number> {
    const room = input.teamId ? getTeamRoom(input.gameId, input.teamId) : getGameRoom(input.gameId);
    const socketIds = await this.io.in(room).allSockets();
    const modeHandler = this.registry.get(input.modeKey);
    const serverTime = new Date().toISOString();
    let sentCount = 0;

    for (const socketId of socketIds) {
      const socket = this.io.sockets.sockets.get(socketId) as RealtimeSocket | undefined;

      if (!socket || socket.data.joinedGameId !== input.gameId) {
        continue;
      }

      const payload = filterPayloadForViewer(input.payload, modeHandler, {
        playerId: socket.data.player.id,
        teamId: socket.data.player.teamId,
      });

      socket.emit(input.eventType, {
        gameId: input.gameId,
        stateVersion: input.stateVersion,
        serverTime,
        ...payload,
      });
      sentCount += 1;
    }

    return sentCount;
  }
}

function filterPayloadForViewer<TPayload extends Record<string, unknown>>(
  payload: TPayload,
  modeHandler: ModeRegistry['get'] extends (...args: any[]) => infer THandler ? THandler : never,
  viewer: { playerId: string; teamId: string | null },
): TPayload {
  if (!('snapshot' in payload) || !payload.snapshot) {
    return payload;
  }

  return {
    ...payload,
    snapshot: modeHandler.filterStateForViewer(payload.snapshot as GameStateSnapshot, viewer),
  } as TPayload;
}
