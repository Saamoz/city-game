import type { FastifyPluginAsync } from 'fastify';
import type { Challenge, JsonObject } from '@city-game/shared';
import { CHALLENGE_KIND_VALUES, CHALLENGE_STATUS_VALUES, errorCodes } from '@city-game/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { DatabaseClient } from '../db/connection.js';
import { challenges, games, zones } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { executeIdempotentMutation } from '../services/idempotency-service.js';

interface ChallengeRow {
  id: string;
  gameId: string;
  zoneId: string | null;
  title: string;
  description: string;
  kind: Challenge['kind'];
  config: JsonObject;
  completionMode: string;
  scoring: Record<string, number>;
  difficulty: Challenge['difficulty'];
  sortOrder: number;
  isDeckActive: boolean;
  status: Challenge['status'];
  currentClaimId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type ChallengeInsertValues = typeof challenges.$inferInsert;

type ChallengeCreateBody = {
  zoneId?: string;
  title: string;
  description: string;
  kind: Challenge['kind'];
  config?: JsonObject;
  completionMode?: string;
  scoring?: Record<string, number>;
  difficulty?: Challenge['difficulty'] | null;
  status?: Challenge['status'];
};

type ChallengeUpdateBody = {
  zoneId?: string | null;
  title?: string;
  description?: string;
  kind?: Challenge['kind'];
  config?: JsonObject;
  completionMode?: string;
  scoring?: Record<string, number>;
  difficulty?: Challenge['difficulty'] | null;
  status?: Challenge['status'];
};

const challengeBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'kind'],
  properties: {
    zoneId: { type: 'string', format: 'uuid' },
    title: { type: 'string', minLength: 1, maxLength: 255 },
    description: { type: 'string', minLength: 1 },
    kind: { type: 'string', enum: [...CHALLENGE_KIND_VALUES] },
    config: {
      type: 'object',
      additionalProperties: true,
    },
    completionMode: {
      type: 'string',
      minLength: 1,
      maxLength: 20,
      pattern: '^[a-z_]+$',
    },
    scoring: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    difficulty: { anyOf: [{ type: 'string', enum: ['easy', 'medium', 'hard'] }, { type: 'null' }] },
    status: { type: 'string', enum: [...CHALLENGE_STATUS_VALUES] },
  },
} as const;

const challengeUpdateBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    zoneId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    title: { type: 'string', minLength: 1, maxLength: 255 },
    description: { type: 'string', minLength: 1 },
    kind: { type: 'string', enum: [...CHALLENGE_KIND_VALUES] },
    config: {
      type: 'object',
      additionalProperties: true,
    },
    completionMode: {
      type: 'string',
      minLength: 1,
      maxLength: 20,
      pattern: '^[a-z_]+$',
    },
    scoring: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    difficulty: { anyOf: [{ type: 'string', enum: ['easy', 'medium', 'hard'] }, { type: 'null' }] },
    status: { type: 'string', enum: [...CHALLENGE_STATUS_VALUES] },
  },
  minProperties: 1,
} as const;

const challengeListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    zoneId: { type: 'string', format: 'uuid' },
    kind: { type: 'string', enum: [...CHALLENGE_KIND_VALUES] },
    status: { type: 'string', enum: [...CHALLENGE_STATUS_VALUES] },
  },
} as const;

const gameParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const challengeParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export const challengeRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/game/:id/challenges',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: gameParamsSchema,
        body: challengeBodySchema,
      },
    },
    async (request, reply) => {
      await executeIdempotentMutation(app, request, reply, async (db) => {
        const { id } = request.params as { id: string };
        await getGameById(db, id);

        const body = request.body as ChallengeCreateBody;
        await assertZoneBelongsToGame(db, id, body.zoneId ?? null);

        const insertValues: ChallengeInsertValues = {
          gameId: id,
          zoneId: body.zoneId ?? null,
          title: body.title,
          description: body.description,
          kind: body.kind,
          config: body.config ?? {},
          completionMode: body.completionMode ?? 'self_report',
          scoring: body.scoring ?? { points: 10 },
          difficulty: body.difficulty ?? null,
          status: body.status ?? 'available',
        };

        const [challenge] = await db.insert(challenges).values(insertValues).returning();

        return {
          gameId: id,
          statusCode: 201,
          body: { challenge: serializeChallengeRow(challenge as ChallengeRow) },
        };
      });
    },
  );

  app.get(
    '/game/:id/challenges',
    {
      schema: {
        params: gameParamsSchema,
        querystring: challengeListQuerySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await getGameById(app.db, id);

      const query = request.query as {
        zoneId?: string;
        kind?: Challenge['kind'];
        status?: Challenge['status'];
      };

      const conditions = [eq(challenges.gameId, id)];

      if (query.zoneId) {
        conditions.push(eq(challenges.zoneId, query.zoneId));
      }

      if (query.kind) {
        conditions.push(eq(challenges.kind, query.kind));
      }

      if (query.status) {
        conditions.push(eq(challenges.status, query.status));
      }

      const rows = await app.db
        .select()
        .from(challenges)
        .where(and(...conditions))
        .orderBy(asc(challenges.sortOrder), asc(challenges.createdAt));

      reply.send({
        challenges: rows.map((row) => serializeChallengeRow(row as ChallengeRow)),
      });
    },
  );

  app.patch(
    '/challenges/:id',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: challengeParamsSchema,
        body: challengeUpdateBodySchema,
      },
    },
    async (request, reply) => {
      await executeIdempotentMutation(app, request, reply, async (db) => {
        const { id } = request.params as { id: string };
        const existingChallenge = await getChallengeByIdOrThrow(db, id);
        const body = request.body as ChallengeUpdateBody;
        const nextZoneId = body.zoneId === undefined ? existingChallenge.zoneId : body.zoneId;
        await assertZoneBelongsToGame(db, existingChallenge.gameId, nextZoneId ?? null);

        const [challenge] = await db
          .update(challenges)
          .set({
            zoneId: nextZoneId ?? null,
            title: body.title ?? existingChallenge.title,
            description: body.description ?? existingChallenge.description,
            kind: body.kind ?? existingChallenge.kind,
            config: body.config ?? existingChallenge.config,
            completionMode: body.completionMode ?? existingChallenge.completionMode,
            scoring: body.scoring ?? existingChallenge.scoring,
            difficulty: body.difficulty === undefined ? existingChallenge.difficulty : body.difficulty,
            status: body.status ?? existingChallenge.status,
            updatedAt: new Date(),
          })
          .where(eq(challenges.id, id))
          .returning();

        return {
          gameId: existingChallenge.gameId,
          statusCode: 200,
          body: { challenge: serializeChallengeRow(challenge as ChallengeRow) },
        };
      });
    },
  );

  app.delete(
    '/challenges/:id',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: challengeParamsSchema,
      },
    },
    async (request, reply) => {
      await executeIdempotentMutation(app, request, reply, async (db) => {
        const challenge = await getChallengeByIdOrThrow(db, (request.params as { id: string }).id);
        await db.delete(challenges).where(eq(challenges.id, challenge.id));

        return {
          gameId: challenge.gameId,
          statusCode: 204,
        };
      });
    },
  );
};

async function getGameById(db: DatabaseClient, gameId: string) {
  const [game] = await db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).limit(1);

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }

  return game;
}

async function getChallengeByIdOrThrow(db: DatabaseClient, challengeId: string) {
  const [challenge] = await db.select().from(challenges).where(eq(challenges.id, challengeId)).limit(1);

  if (!challenge) {
    throw new AppError(errorCodes.validationError, {
      message: 'Challenge not found.',
    });
  }

  return challenge as ChallengeRow;
}

async function assertZoneBelongsToGame(db: DatabaseClient, gameId: string, zoneId: string | null) {
  if (!zoneId) {
    return;
  }

  const [zone] = await db
    .select({ id: zones.id })
    .from(zones)
    .where(and(eq(zones.id, zoneId), eq(zones.gameId, gameId)))
    .limit(1);

  if (!zone) {
    throw new AppError(errorCodes.validationError, {
      message: 'Zone does not belong to this game.',
    });
  }
}

function serializeChallengeRow(row: ChallengeRow): Challenge {
  return {
    id: row.id,
    gameId: row.gameId,
    zoneId: row.zoneId,
    title: row.title,
    description: row.description,
    kind: row.kind,
    config: row.config,
    completionMode: row.completionMode,
    scoring: row.scoring,
    difficulty: row.difficulty,
    sortOrder: row.sortOrder,
    isDeckActive: row.isDeckActive,
    status: row.status,
    currentClaimId: row.currentClaimId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
