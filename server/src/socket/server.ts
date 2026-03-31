import { Server as SocketIOServer } from 'socket.io';
import { socketClientEventTypes, errorCodes } from '@city-game/shared';
import type { FastifyInstance } from 'fastify';
import { AppError, buildErrorResponse } from '../lib/errors.js';
import { getPlayerBySessionToken, getSessionTokenFromCookieHeader } from '../lib/auth.js';
import { Broadcaster, type RealtimePlayerIdentity, type RealtimeServer, type RealtimeSocket } from './broadcaster.js';
import { getGameRoom, getTeamRoom } from './rooms.js';

interface JoinGamePayload {
  gameId: string;
  lastStateVersion?: number;
}

interface LeaveGamePayload {
  gameId: string;
}

export function registerRealtime(app: FastifyInstance): void {
  const io = new SocketIOServer(app.server, {
    path: '/socket.io',
    serveClient: false,
  }) as RealtimeServer;

  app.decorate('io', io);
  app.decorate('broadcaster', new Broadcaster(io, app.modeRegistry));

  io.use(async (socket, next) => {
    try {
      const cookieHeader = normalizeCookieHeader(socket.handshake.headers.cookie);
      const sessionToken = getSessionTokenFromCookieHeader(cookieHeader);

      if (!sessionToken) {
        throw new AppError(errorCodes.unauthorized);
      }

      const player = await getPlayerBySessionToken(app.db, sessionToken);
      socket.data.sessionToken = sessionToken;
      socket.data.player = toRealtimePlayer(player);
      socket.data.joinedGameId = null;
      next();
    } catch (error) {
      next(toSocketError(error));
    }
  });

  io.on('connection', (socket) => {
    socket.on(socketClientEventTypes.joinGame, async (payload: JoinGamePayload, ack?: (response: unknown) => void) => {
      try {
        const player = await getPlayerBySessionToken(app.db, socket.data.sessionToken);
        socket.data.player = toRealtimePlayer(player);
        await joinGameRooms(socket, payload.gameId);

        ack?.({
          ok: true,
          gameId: payload.gameId,
          teamId: socket.data.player.teamId,
        });
      } catch (error) {
        ack?.({
          ok: false,
          error: serializeSocketError(error),
        });
      }
    });

    socket.on(socketClientEventTypes.leaveGame, async (payload: LeaveGamePayload, ack?: (response: unknown) => void) => {
      try {
        await leaveGameRooms(socket, payload.gameId);
        ack?.({
          ok: true,
          gameId: payload.gameId,
        });
      } catch (error) {
        ack?.({
          ok: false,
          error: serializeSocketError(error),
        });
      }
    });
  });

  app.addHook('onClose', async () => {
    await new Promise<void>((resolve, reject) => {
      io.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });
}

async function joinGameRooms(socket: RealtimeSocket, gameId: string): Promise<void> {
  if (!gameId) {
    throw new AppError(errorCodes.validationError, {
      message: 'gameId is required.',
    });
  }

  if (socket.data.player.gameId !== gameId) {
    throw new AppError(errorCodes.unauthorized, {
      message: 'Player cannot subscribe to another game.',
    });
  }

  if (socket.data.joinedGameId === gameId) {
    return;
  }

  await leaveCurrentRooms(socket);
  await socket.join(getGameRoom(gameId));

  if (socket.data.player.teamId) {
    await socket.join(getTeamRoom(gameId, socket.data.player.teamId));
  }

  socket.data.joinedGameId = gameId;
}

async function leaveGameRooms(socket: RealtimeSocket, gameId: string): Promise<void> {
  if (socket.data.joinedGameId && socket.data.joinedGameId !== gameId) {
    throw new AppError(errorCodes.validationError, {
      message: 'Socket is not subscribed to that game.',
    });
  }

  await leaveCurrentRooms(socket);
  socket.data.joinedGameId = null;
}

async function leaveCurrentRooms(socket: RealtimeSocket): Promise<void> {
  const joinedGameId = socket.data.joinedGameId;

  if (!joinedGameId) {
    return;
  }

  await socket.leave(getGameRoom(joinedGameId));

  if (socket.data.player.teamId) {
    await socket.leave(getTeamRoom(joinedGameId, socket.data.player.teamId));
  }
}

function normalizeCookieHeader(cookieHeader: string | string[] | undefined): string | undefined {
  if (Array.isArray(cookieHeader)) {
    return cookieHeader[0];
  }

  return cookieHeader;
}

function toRealtimePlayer(player: RealtimePlayerIdentity): RealtimePlayerIdentity {
  return {
    id: player.id,
    gameId: player.gameId,
    teamId: player.teamId,
  };
}

function toSocketError(error: unknown): Error {
  const socketError = new Error(serializeSocketError(error).message) as Error & { data?: unknown };
  socketError.data = serializeSocketError(error);
  return socketError;
}

function serializeSocketError(error: unknown) {
  if (error instanceof AppError) {
    return error.toResponse().error;
  }

  return buildErrorResponse(errorCodes.internalServerError).error;
}
