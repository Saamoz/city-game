import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { errorCodes, socketServerEventTypes } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { games, players, teams } from '../db/schema.js';
import { generateSessionToken, getSerializedSessionCookie } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { gpsPayloadSchema } from '../middleware/gps-validation.js';
import { executeIdempotentMutation } from '../services/idempotency-service.js';
import { updatePlayerLocation } from '../services/player-location-service.js';

const paramsWithGameIdSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const registerPlayerBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['display_name'],
  properties: {
    display_name: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

const joinTeamBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['join_code'],
  properties: {
    join_code: { type: 'string', minLength: 1, maxLength: 8 },
  },
} as const;

const pushSubscribeBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['endpoint', 'expirationTime', 'keys'],
  properties: {
    endpoint: { type: 'string', minLength: 1, maxLength: 2000 },
    expirationTime: { anyOf: [{ type: 'null' }, { type: 'number' }] },
    keys: {
      type: 'object',
      additionalProperties: true,
      required: ['p256dh', 'auth'],
      properties: {
        p256dh: { type: 'string', minLength: 1 },
        auth: { type: 'string', minLength: 1 },
      },
    },
  },
} as const;

export const playerRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/game/:id/players',
    {
      schema: {
        params: paramsWithGameIdSchema,
        body: registerPlayerBodySchema,
      },
    },
    async (request, reply) => {
      await executeIdempotentMutation(app, request, reply, async (db) => {
        const { id } = request.params as { id: string };
        await getGameById(db, id);

        const body = request.body as { display_name: string };
        const sessionToken = generateSessionToken();

        const [player] = await db
          .insert(players)
          .values({
            gameId: id,
            teamId: null,
            displayName: body.display_name,
            sessionToken,
            metadata: {},
          })
          .returning();

        return {
          gameId: id,
          playerId: player.id,
          statusCode: 201,
          body: { player: serializePlayer(player) },
          responseHeaders: {
            'set-cookie': getSerializedSessionCookie(sessionToken),
          },
        };
      });
    },
  );

  app.post(
    '/game/:id/teams/join',
    {
      preHandler: [app.authenticate],
      schema: {
        params: paramsWithGameIdSchema,
        body: joinTeamBodySchema,
      },
    },
    async (request, reply) => {
      let broadcastPayload: { gameId: string; modeKey: string; stateVersion: number; player: ReturnType<typeof serializePlayer>; team: ReturnType<typeof serializeTeam> } | null = null;

      await executeIdempotentMutation(app, request, reply, async (db) => {
        const { id } = request.params as { id: string };
        const game = await getGameById(db, id);

        if (request.player?.gameId !== id) {
          throw new AppError(errorCodes.teamNotFound);
        }

        const body = request.body as { join_code: string };
        const [team] = await db
          .select()
          .from(teams)
          .where(and(eq(teams.gameId, id), eq(teams.joinCode, body.join_code.toUpperCase())))
          .limit(1);

        if (!team) {
          throw new AppError(errorCodes.teamNotFound);
        }

        const [player] = await db
          .update(players)
          .set({ teamId: team.id })
          .where(eq(players.id, request.player.id))
          .returning();

        request.player = player;
        broadcastPayload = {
          gameId: id,
          modeKey: game.modeKey,
          stateVersion: game.stateVersion,
          player: serializePlayer(player),
          team: serializeTeam(team),
        };

        return {
          gameId: id,
          playerId: player.id,
          statusCode: 200,
          body: {
            player: serializePlayer(player),
            team: serializeTeam(team),
          },
        };
      }, async () => {
        if (!broadcastPayload) {
          return;
        }

        await app.broadcaster.send({
          gameId: broadcastPayload.gameId,
          modeKey: broadcastPayload.modeKey,
          eventType: socketServerEventTypes.playerJoined,
          stateVersion: broadcastPayload.stateVersion,
          payload: {
            player: broadcastPayload.player,
            team: broadcastPayload.team,
          },
        });
      });
    },
  );

  app.post(
    '/players/me/leave-team',
    {
      preHandler: [app.authenticate],
    },
    async (request, reply) => {
      let broadcastPayload: { gameId: string; modeKey: string; stateVersion: number; player: ReturnType<typeof serializePlayer> } | null = null;

      await executeIdempotentMutation(app, request, reply, async (db) => {
        const player = request.player!;
        const game = await getGameById(db, player.gameId);

        if (game.status !== 'setup') {
          throw new AppError(errorCodes.validationError, {
            message: 'Teams can only be changed before the game starts.',
          });
        }

        const [updatedPlayer] = await db
          .update(players)
          .set({ teamId: null })
          .where(eq(players.id, player.id))
          .returning();

        request.player = updatedPlayer;
        broadcastPayload = {
          gameId: updatedPlayer.gameId,
          modeKey: game.modeKey,
          stateVersion: game.stateVersion,
          player: serializePlayer(updatedPlayer),
        };

        return {
          gameId: updatedPlayer.gameId,
          playerId: updatedPlayer.id,
          statusCode: 200,
          body: { player: serializePlayer(updatedPlayer) },
        };
      }, async () => {
        if (!broadcastPayload) {
          return;
        }

        await app.broadcaster.send({
          gameId: broadcastPayload.gameId,
          modeKey: broadcastPayload.modeKey,
          eventType: socketServerEventTypes.playerJoined,
          stateVersion: broadcastPayload.stateVersion,
          payload: {
            player: broadcastPayload.player,
            team: null,
          },
        });
      });
    },
  );

  app.get(
    '/game/:id/players',
    {
      schema: {
        params: paramsWithGameIdSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getGameById(app.db, id);

      const rows = await app.db
        .select()
        .from(players)
        .where(eq(players.gameId, id));

      reply.send({ players: rows.map(serializePlayer) });
    },
  );

  app.get(
    '/players/me',
    {
      preHandler: [app.authenticate],
    },
    async (request, reply) => {
      reply.send({ player: serializePlayer(request.player!) });
    },
  );

  app.post(
    '/players/me/push-subscribe',
    {
      preHandler: [app.authenticate],
      schema: {
        body: pushSubscribeBodySchema,
      },
    },
    async (request, reply) => {
      await executeIdempotentMutation(app, request, reply, async (db) => {
        const body = request.body as {
          endpoint: string;
          expirationTime: number | null;
          keys: { p256dh: string; auth: string; [key: string]: string };
        };

        const [player] = await db
          .update(players)
          .set({
            pushSubscription: {
              endpoint: body.endpoint,
              expirationTime: body.expirationTime,
              keys: body.keys,
            },
          })
          .where(eq(players.id, request.player!.id))
          .returning();

        request.player = player;

        return {
          gameId: player.gameId,
          playerId: player.id,
          statusCode: 200,
          body: {
            player: serializePlayer(player),
          },
        };
      });
    },
  );

  app.post(
    '/players/me/location',
    {
      preHandler: [app.authenticate, app.validateGps],
      schema: {
        body: gpsPayloadSchema,
      },
    },
    async (request, reply) => {
      await executeIdempotentMutation(app, request, reply, async (db) => {
        const gpsPayload = request.gpsPayload!;
        const result = await updatePlayerLocation(db, {
          playerId: request.player!.id,
          gpsPayload,
        });

        request.player = result.player;

        return {
          gameId: result.player.gameId,
          playerId: result.player.id,
          statusCode: 200,
          body: {
            player: serializePlayer(result.player),
            gps: gpsPayload,
            tracking: {
              enabled: result.tracking.enabled,
              sampleStored: result.sampleStored,
              retentionHours: result.tracking.retentionHours,
            },
          },
        };
      });
    },
  );
};

async function getGameById(db: DatabaseClient, gameId: string) {
  const [game] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }

  return game;
}

function serializePlayer(player: typeof players.$inferSelect) {
  const { sessionToken: _sessionToken, ...safePlayer } = player;
  return safePlayer;
}

function serializeTeam(team: typeof teams.$inferSelect) {
  return team;
}
