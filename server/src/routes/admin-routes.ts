import type { FastifyPluginAsync } from 'fastify';
import { RESOURCE_TYPE_VALUES, STATE_VERSION_HEADER } from '@city-game/shared';
import { executeIdempotentMutation } from '../services/idempotency-service.js';
import {
  adminAdjustResources,
  adminAssignZoneOwner,
  adminForceCompleteChallenge,
  adminMovePlayerTeam,
  adminRebroadcastState,
  adminResetChallenge,
} from '../services/admin-override-service.js';
import { broadcastFullStateToGame, syncPlayerSocketMembership } from '../socket/admin-sync.js';

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const forceCompleteBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    submission: {},
    notes: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const resetBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    notes: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const assignOwnerBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['teamId'],
  properties: {
    teamId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    notes: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const moveTeamBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['teamId'],
  properties: {
    teamId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    notes: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const rebroadcastBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    notes: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const adjustResourcesBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['gameId', 'teamId', 'resourceType', 'delta'],
  properties: {
    gameId: { type: 'string', format: 'uuid' },
    teamId: { type: 'string', format: 'uuid' },
    resourceType: { type: 'string', enum: [...RESOURCE_TYPE_VALUES] },
    delta: { type: 'integer' },
    reason: { type: 'string', minLength: 1, maxLength: 100 },
    notes: { type: 'string', minLength: 1, maxLength: 500 },
    allowNegative: { type: 'boolean' },
  },
} as const;

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/admin/challenges/:id/force-complete',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: idParamsSchema,
        body: forceCompleteBodySchema,
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as { submission?: unknown; notes?: string };
      await executeAdminOverride(app, request, reply, async (db) => {
        const result = await adminForceCompleteChallenge(db, {
          challengeId: (request.params as { id: string }).id,
          submission: (body.submission ?? null) as never,
          notes: body.notes,
        });

        return result;
      });
    },
  );

  app.post(
    '/admin/challenges/:id/reset',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: idParamsSchema,
        body: resetBodySchema,
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as { notes?: string };
      await executeAdminOverride(app, request, reply, async (db) =>
        adminResetChallenge(db, {
          challengeId: (request.params as { id: string }).id,
          notes: body.notes,
        }),
      );
    },
  );

  app.post(
    '/admin/zones/:id/assign-owner',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: idParamsSchema,
        body: assignOwnerBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as { teamId: string | null; notes?: string };
      await executeAdminOverride(app, request, reply, async (db) =>
        adminAssignZoneOwner(db, {
          zoneId: (request.params as { id: string }).id,
          teamId: body.teamId,
          notes: body.notes,
        }),
      );
    },
  );

  app.post(
    '/admin/players/:id/move-team',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: idParamsSchema,
        body: moveTeamBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as { teamId: string | null; notes?: string };
      await executeAdminOverride(
        app,
        request,
        reply,
        async (db) =>
          adminMovePlayerTeam(db, {
            playerId: (request.params as { id: string }).id,
            teamId: body.teamId,
            notes: body.notes,
          }),
        async (result) => {
          const playerId = (result.body as { player?: { id?: string } }).player?.id;
          if (playerId) {
            await syncPlayerSocketMembership(app, playerId);
          }
          await broadcastFullStateToGame(app, result.gameId);
        },
      );
    },
  );

  app.post(
    '/admin/game/:id/rebroadcast-state',
    {
      preHandler: [app.requireAdmin],
      schema: {
        params: idParamsSchema,
        body: rebroadcastBodySchema,
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as { notes?: string };
      await executeAdminOverride(
        app,
        request,
        reply,
        async (db) =>
          adminRebroadcastState(db, {
            gameId: (request.params as { id: string }).id,
            notes: body.notes,
          }),
        async (result) => {
          await broadcastFullStateToGame(app, result.gameId);
        },
      );
    },
  );

  app.post(
    '/admin/resources/adjust',
    {
      preHandler: [app.requireAdmin],
      schema: {
        body: adjustResourcesBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as {
        gameId: string;
        teamId: string;
        resourceType: (typeof RESOURCE_TYPE_VALUES)[number];
        delta: number;
        reason?: string;
        notes?: string;
        allowNegative?: boolean;
      };
      await executeAdminOverride(app, request, reply, async (db) =>
        adminAdjustResources(db, {
          gameId: body.gameId,
          teamId: body.teamId,
          resourceType: body.resourceType,
          delta: body.delta,
          reason: body.reason,
          notes: body.notes,
          allowNegative: body.allowNegative,
        }),
      );
    },
  );
};

async function executeAdminOverride(
  app: Parameters<FastifyPluginAsync>[0],
  request: Parameters<FastifyPluginAsync>[0] extends never ? never : any,
  reply: any,
  run: (db: Parameters<typeof executeIdempotentMutation>[3] extends (db: infer T) => any ? T : never) => Promise<{
    gameId: string;
    stateVersion: number;
    body: unknown;
  }>,
  onCommitted?: (result: { gameId: string; stateVersion: number; body: unknown }) => Promise<void> | void,
) {
  let committedResult: { gameId: string; stateVersion: number; body: unknown } | null = null;

  await executeIdempotentMutation(
    app,
    request,
    reply,
    async (db) => {
      const result = await run(db);
      committedResult = result;

      return {
        gameId: result.gameId,
        statusCode: 200,
        body: result.body,
        responseHeaders: {
          [STATE_VERSION_HEADER]: String(result.stateVersion),
        },
      };
    },
    async () => {
      if (committedResult && onCommitted) {
        await onCommitted(committedResult);
        return;
      }

      if (committedResult) {
        await broadcastFullStateToGame(app, committedResult.gameId);
      }
    },
  );
}
