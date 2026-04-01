import { eq } from 'drizzle-orm';
import { socketServerEventTypes } from '@city-game/shared';
import type { FastifyInstance } from 'fastify';
import { players } from '../db/schema.js';
import { buildGameStateSnapshot } from '../services/state-service.js';
import type { RealtimeSocket } from './broadcaster.js';
import { getGameRoom, getTeamRoom } from './rooms.js';

export async function broadcastFullStateToGame(app: FastifyInstance, gameId: string): Promise<number> {
  const socketIds = await app.io.in(getGameRoom(gameId)).allSockets();
  let sentCount = 0;

  for (const socketId of socketIds) {
    const socket = app.io.sockets.sockets.get(socketId) as RealtimeSocket | undefined;

    if (!socket || socket.data.joinedGameId !== gameId) {
      continue;
    }

    const snapshot = await buildGameStateSnapshot(app.db, app.modeRegistry, {
      gameId,
      playerId: socket.data.player.id,
    });

    socket.emit(socketServerEventTypes.gameStateSync, {
      gameId,
      stateVersion: snapshot.game.stateVersion,
      serverTime: new Date().toISOString(),
      snapshot,
    });
    sentCount += 1;
  }

  return sentCount;
}

export async function syncPlayerSocketMembership(app: FastifyInstance, playerId: string): Promise<void> {
  const [player] = await app.db.select().from(players).where(eq(players.id, playerId)).limit(1);

  if (!player) {
    return;
  }

  for (const socket of app.io.sockets.sockets.values() as Iterable<RealtimeSocket>) {
    if (socket.data.player.id !== playerId) {
      continue;
    }

    const previousGameId = socket.data.joinedGameId;
    const previousTeamId = socket.data.joinedTeamId;
    socket.data.player.teamId = player.teamId;

    if (!previousGameId || previousGameId !== player.gameId) {
      socket.data.joinedTeamId = player.teamId;
      continue;
    }

    if (previousTeamId && previousTeamId !== player.teamId) {
      await socket.leave(getTeamRoom(previousGameId, previousTeamId));
    }

    if (player.teamId && previousTeamId !== player.teamId) {
      await socket.join(getTeamRoom(previousGameId, player.teamId));
    }

    socket.data.joinedTeamId = player.teamId;
  }
}
