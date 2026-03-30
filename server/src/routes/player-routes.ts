import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { errorCodes } from '@city-game/shared';
import { games, players, teams } from '../db/schema.js';
import { generateSessionToken, setSessionCookie } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';

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
      const { id } = request.params as { id: string };
      await getGameById(app, id);

      const body = request.body as { display_name: string };
      const sessionToken = generateSessionToken();

      const [player] = await app.db
        .insert(players)
        .values({
          gameId: id,
          teamId: null,
          displayName: body.display_name,
          sessionToken,
          metadata: {},
        })
        .returning();

      setSessionCookie(reply, sessionToken);
      reply.status(201).send({ player: serializePlayer(player) });
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
      const { id } = request.params as { id: string };
      await getGameById(app, id);

      if (request.player?.gameId !== id) {
        throw new AppError(errorCodes.teamNotFound);
      }

      const body = request.body as { join_code: string };
      const [team] = await app.db
        .select()
        .from(teams)
        .where(and(eq(teams.gameId, id), eq(teams.joinCode, body.join_code.toUpperCase())))
        .limit(1);

      if (!team) {
        throw new AppError(errorCodes.teamNotFound);
      }

      const [player] = await app.db
        .update(players)
        .set({ teamId: team.id })
        .where(eq(players.id, request.player.id))
        .returning();

      request.player = player;
      reply.send({
        player: serializePlayer(player),
        team: serializeTeam(team),
      });
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
};

async function getGameById(app: FastifyInstance, gameId: string) {
  const [game] = await app.db.select().from(games).where(eq(games.id, gameId)).limit(1);

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
