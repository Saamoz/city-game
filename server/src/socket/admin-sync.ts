import { eq } from 'drizzle-orm';
import { socketServerEventTypes } from '@city-game/shared';
import type { FastifyInstance } from 'fastify';
import { players } from '../db/schema.js';
import { buildViewerSnapshot, hasViewer, loadGameState } from '../services/state-service.js';
import type { RealtimeSocket } from './broadcaster.js';
import { getGameRoom, getTeamRoom } from './rooms.js';

export async function broadcastFullStateToGame(app: FastifyInstance, gameId: string): Promise<number> {
  const socketIds = await app.io.in(getGameRoom(gameId)).allSockets();
  let sentCount = 0;

  if (socketIds.size === 0) {
    return sentCount;
  }

  // Load once and tailor per viewer, rather than rebuilding the whole snapshot for every socket.
  const state = await loadGameState(app.db, gameId);
  const serverTime = new Date().toISOString();

  for (const socketId of socketIds) {
    const socket = app.io.sockets.sockets.get(socketId) as RealtimeSocket | undefined;

    if (!socket || socket.data.joinedGameId !== gameId || !hasViewer(state, socket.data.player.id)) {
      continue;
    }

    const snapshot = buildViewerSnapshot(app.modeRegistry, state, socket.data.player.id);

    socket.emit(socketServerEventTypes.gameStateSync, {
      gameId,
      stateVersion: snapshot.game.stateVersion,
      serverTime,
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
