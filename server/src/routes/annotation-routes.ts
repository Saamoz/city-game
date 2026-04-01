import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  ANNOTATION_VISIBILITY_VALUES,
  STATE_VERSION_HEADER,
  errorCodes,
  eventTypes,
  socketServerEventTypes,
  type Annotation,
  type AnnotationType,
  type GeoJsonGeometry,
  type JsonObject,
} from '@city-game/shared';
import { asc, eq } from 'drizzle-orm';
import type { DatabaseClient } from '../db/connection.js';
import { annotations, games, players } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { executeIdempotentMutation } from '../services/idempotency-service.js';
import { appendEvents } from '../services/event-service.js';
import { filterAnnotationsForViewer, serializeAnnotationRow } from '../services/state-service.js';

const ANNOTATION_TYPE_VALUES = ['marker', 'line', 'polygon', 'circle', 'note'] as const;

type AnnotationVisibility = (typeof ANNOTATION_VISIBILITY_VALUES)[number];

type AnnotationCreateBody = {
  type: AnnotationType;
  geometry: GeoJsonGeometry;
  label?: string;
  style?: JsonObject;
  visibility?: AnnotationVisibility;
};

const gameParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const annotationParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const geometrySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'coordinates'],
  properties: {
    type: { type: 'string', enum: ['Point', 'LineString', 'Polygon'] },
    coordinates: {},
  },
} as const;

const annotationBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'geometry'],
  properties: {
    type: { type: 'string', enum: [...ANNOTATION_TYPE_VALUES] },
    geometry: geometrySchema,
    label: { type: 'string', minLength: 1, maxLength: 255 },
    style: {
      type: 'object',
      additionalProperties: true,
    },
    visibility: { type: 'string', enum: [...ANNOTATION_VISIBILITY_VALUES] },
  },
} as const;

export const annotationRoutes: FastifyPluginAsync = async (app) => {
  const requireAnnotationActor = async (request: FastifyRequest, reply: FastifyReply) => {
    if (app.isAdminRequest(request)) {
      return;
    }

    await app.authenticate(request, reply);
  };

  app.post(
    '/game/:id/annotations',
    {
      preHandler: [requireAnnotationActor],
      schema: {
        params: gameParamsSchema,
        body: annotationBodySchema,
      },
    },
    async (request, reply) => {
      let broadcastPayload:
        | {
            gameId: string;
            modeKey: string;
            stateVersion: number;
            annotation: Annotation;
            audienceTeamId: string | null;
          }
        | null = null;

      await executeIdempotentMutation(
        app,
        request,
        reply,
        async (db) => {
          const { id: gameId } = request.params as { id: string };
          const game = await getGameById(db, gameId);
          const player = request.player;
          const isAdmin = app.isAdminRequest(request);

          if (!isAdmin && player?.gameId !== gameId) {
            throw new AppError(errorCodes.unauthorized, {
              message: 'Player cannot access another game.',
            });
          }

          const body = request.body as AnnotationCreateBody;
          assertGeometryMatchesType(body.type, body.geometry);
          const visibility = body.visibility ?? 'all';

          if (isAdmin && visibility === 'team') {
            throw new AppError(errorCodes.annotationForbidden, {
              message: 'Admin-created annotations must use visibility all.',
            });
          }

          if (!isAdmin && body.type !== 'marker') {
            throw new AppError(errorCodes.annotationForbidden, {
              message: 'Players can only create marker annotations.',
            });
          }

          if (!isAdmin && visibility === 'team' && !player?.teamId) {
            throw new AppError(errorCodes.annotationForbidden, {
              message: 'Team-only annotations require a team.',
            });
          }

          const [annotationRow] = await db
            .insert(annotations)
            .values({
              gameId,
              createdBy: isAdmin ? null : (player?.id ?? null),
              type: body.type,
              geometry: body.geometry as unknown as typeof annotations.$inferInsert.geometry,
              label: body.label ?? null,
              style: body.style ?? {},
              visibility,
            })
            .returning();

          const annotation = serializeAnnotationRow(annotationRow);
          const actorType = isAdmin ? 'admin' : 'player';
          const actorId = isAdmin ? null : (player?.id ?? null);
          const actorTeamId = isAdmin ? null : (player?.teamId ?? null);
          const eventResult = await appendEvents(db, {
            gameId,
            events: [
              {
                eventType: eventTypes.annotationAdded,
                entityType: 'annotation',
                entityId: annotation.id,
                actorType,
                actorId,
                actorTeamId,
                beforeState: null,
                afterState: annotation as unknown as JsonObject,
                meta: { annotation: annotation as unknown as JsonObject },
                payload: { annotation },
              },
            ],
          });

          broadcastPayload = {
            gameId,
            modeKey: game.modeKey,
            stateVersion: eventResult.stateVersion,
            annotation,
            audienceTeamId: visibility === 'team' ? (player?.teamId ?? null) : null,
          };

          return {
            gameId,
            playerId: player?.id ?? null,
            statusCode: 201,
            body: { annotation },
            responseHeaders: {
              [STATE_VERSION_HEADER]: String(eventResult.stateVersion),
            },
          };
        },
        async () => {
          if (!broadcastPayload) {
            return;
          }

          await app.broadcaster.send({
            gameId: broadcastPayload.gameId,
            modeKey: broadcastPayload.modeKey,
            eventType: socketServerEventTypes.annotationAdded,
            stateVersion: broadcastPayload.stateVersion,
            teamId: broadcastPayload.audienceTeamId ?? undefined,
            payload: {
              annotation: broadcastPayload.annotation,
            },
          });
        },
      );
    },
  );

  app.get(
    '/game/:id/annotations',
    {
      preHandler: [requireAnnotationActor],
      schema: {
        params: gameParamsSchema,
      },
    },
    async (request, reply) => {
      const { id: gameId } = request.params as { id: string };
      const game = await getGameById(app.db, gameId);
      const isAdmin = app.isAdminRequest(request);

      if (!isAdmin && request.player?.gameId !== gameId) {
        throw new AppError(errorCodes.unauthorized, {
          message: 'Player cannot access another game.',
        });
      }

      const rows = await app.db
        .select()
        .from(annotations)
        .where(eq(annotations.gameId, game.id))
        .orderBy(asc(annotations.createdAt));

      if (isAdmin) {
        reply.send({
          annotations: rows.map((row) => serializeAnnotationRow(row)),
        });
        return;
      }

      const playerRows = await app.db
        .select()
        .from(players)
        .where(eq(players.gameId, game.id))
        .orderBy(asc(players.createdAt));

      reply.send({
        annotations: filterAnnotationsForViewer(rows, playerRows, request.player?.teamId ?? null).map((row) =>
          serializeAnnotationRow(row),
        ),
      });
    },
  );

  app.delete(
    '/annotations/:id',
    {
      preHandler: [requireAnnotationActor],
      schema: {
        params: annotationParamsSchema,
      },
    },
    async (request, reply) => {
      let broadcastPayload:
        | {
            gameId: string;
            modeKey: string;
            stateVersion: number;
            annotationId: string;
            audienceTeamId: string | null;
          }
        | null = null;

      await executeIdempotentMutation(
        app,
        request,
        reply,
        async (db) => {
          const annotationRow = await getAnnotationById(db, (request.params as { id: string }).id);
          const game = await getGameById(db, annotationRow.gameId);
          const player = request.player;
          const isAdmin = app.isAdminRequest(request);

          if (!isAdmin && player?.gameId !== annotationRow.gameId) {
            throw new AppError(errorCodes.unauthorized, {
              message: 'Player cannot access another game.',
            });
          }

          if (!isAdmin && annotationRow.createdBy !== player?.id) {
            throw new AppError(errorCodes.annotationForbidden, {
              message: 'Players can only delete their own annotations.',
            });
          }

          await db.delete(annotations).where(eq(annotations.id, annotationRow.id));

          const annotation = serializeAnnotationRow(annotationRow);
          const creatorTeamId = annotationRow.createdBy ? await getPlayerTeamId(db, annotationRow.createdBy) : null;
          const actorType = isAdmin ? 'admin' : 'player';
          const actorId = isAdmin ? null : (player?.id ?? null);
          const actorTeamId = isAdmin ? null : (player?.teamId ?? null);
          const eventResult = await appendEvents(db, {
            gameId: annotationRow.gameId,
            events: [
              {
                eventType: eventTypes.annotationRemoved,
                entityType: 'annotation',
                entityId: annotationRow.id,
                actorType,
                actorId,
                actorTeamId,
                beforeState: annotation as unknown as JsonObject,
                afterState: null,
                meta: { annotationId: annotationRow.id },
                payload: { annotationId: annotationRow.id },
              },
            ],
          });

          broadcastPayload = {
            gameId: annotationRow.gameId,
            modeKey: game.modeKey,
            stateVersion: eventResult.stateVersion,
            annotationId: annotationRow.id,
            audienceTeamId: annotationRow.visibility === 'team' ? creatorTeamId : null,
          };

          return {
            gameId: annotationRow.gameId,
            playerId: player?.id ?? null,
            statusCode: 200,
            body: { annotationId: annotationRow.id },
            responseHeaders: {
              [STATE_VERSION_HEADER]: String(eventResult.stateVersion),
            },
          };
        },
        async () => {
          if (!broadcastPayload) {
            return;
          }

          await app.broadcaster.send({
            gameId: broadcastPayload.gameId,
            modeKey: broadcastPayload.modeKey,
            eventType: socketServerEventTypes.annotationRemoved,
            stateVersion: broadcastPayload.stateVersion,
            teamId: broadcastPayload.audienceTeamId ?? undefined,
            payload: {
              annotationId: broadcastPayload.annotationId,
            },
          });
        },
      );
    },
  );
};

async function getGameById(db: DatabaseClient, gameId: string) {
  const [game] = await db
    .select({ id: games.id, modeKey: games.modeKey })
    .from(games)
    .where(eq(games.id, gameId))
    .limit(1);

  if (!game) {
    throw new AppError(errorCodes.gameNotFound);
  }

  return game;
}

async function getAnnotationById(db: DatabaseClient, annotationId: string) {
  const [annotation] = await db.select().from(annotations).where(eq(annotations.id, annotationId)).limit(1);

  if (!annotation) {
    throw new AppError(errorCodes.annotationNotFound);
  }

  return annotation;
}

async function getPlayerTeamId(db: DatabaseClient, playerId: string): Promise<string | null> {
  const [player] = await db.select({ teamId: players.teamId }).from(players).where(eq(players.id, playerId)).limit(1);
  return player?.teamId ?? null;
}

function assertGeometryMatchesType(type: AnnotationType, geometry: GeoJsonGeometry): void {
  switch (type) {
    case 'marker':
    case 'note':
    case 'circle':
      assertPointGeometry(geometry, type);
      return;
    case 'line':
      assertLineStringGeometry(geometry, type);
      return;
    case 'polygon':
      assertPolygonGeometry(geometry, type);
      return;
    default:
      throw new AppError(errorCodes.validationError, {
        message: `Unsupported annotation type ${type}.`,
      });
  }
}

function assertPointGeometry(geometry: GeoJsonGeometry, type: AnnotationType): void {
  if (geometry.type !== 'Point' || !isPosition(geometry.coordinates)) {
    throw new AppError(errorCodes.validationError, {
      message: `${type} annotations require Point geometry.`,
    });
  }
}

function assertLineStringGeometry(geometry: GeoJsonGeometry, type: AnnotationType): void {
  if (geometry.type !== 'LineString' || geometry.coordinates.length < 2 || !geometry.coordinates.every(isPosition)) {
    throw new AppError(errorCodes.validationError, {
      message: `${type} annotations require a valid LineString geometry.`,
    });
  }
}

function assertPolygonGeometry(geometry: GeoJsonGeometry, type: AnnotationType): void {
  const hasValidRings = geometry.type === 'Polygon'
    && geometry.coordinates.length >= 1
    && geometry.coordinates.every((ring) => ring.length >= 4 && ring.every(isPosition));

  if (!hasValidRings) {
    throw new AppError(errorCodes.validationError, {
      message: `${type} annotations require a valid Polygon geometry.`,
    });
  }
}

function isPosition(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length >= 2
    && value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate));
}
