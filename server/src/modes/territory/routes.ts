import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { and, eq, ne } from 'drizzle-orm';
import {
  socketServerEventTypes,
  type Challenge,
  type ChallengeClaim,
  type GpsPayload,
  type JsonObject,
} from '@city-game/shared';
import { getModeHandlerForGame } from '../index.js';
import { teams } from '../../db/schema.js';
import { buildErrorResponse } from '../../lib/errors.js';
import { gpsPayloadSchema } from '../../middleware/gps-validation.js';
import { executeIdempotentMutation } from '../../services/idempotency-service.js';
import { evaluateConfiguredWinConditions } from '../../services/win-condition-service.js';
import type { TerritoryPostCommitData } from './handler.js';

const challengeParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

const completeChallengeBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    submission: {},
    gps: gpsPayloadSchema,
  },
} as const;

const notImplementedResponse = buildErrorResponse('INTERNAL_SERVER_ERROR', {
  message: 'Territory mode action endpoints are not implemented yet.',
});

export const territoryRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/challenges/:id/claim',
    {
      preHandler: [app.authenticate, app.requireTeam, app.validateGps],
      schema: {
        params: challengeParamsSchema,
        body: gpsPayloadSchema,
      },
    },
    async (request, reply) => {
      let broadcastPayload:
        | {
            gameId: string;
            stateVersion: number;
            challenge: Challenge;
            claim: ChallengeClaim;
          }
        | null = null;

      await executeIdempotentMutation(
        app,
        request,
        reply,
        async (db) => {
          const player = request.player;
          const gpsPayload = request.gpsPayload;

          if (!player?.teamId || !gpsPayload) {
            throw new Error('Authenticated team player with GPS payload expected.');
          }

          const handler = await getModeHandlerForGame(db, app.modeRegistry, player.gameId);
          const result = await handler.handleAction(
            {
              type: 'claim',
              challengeId: (request.params as { id: string }).id,
              gameId: player.gameId,
              playerId: player.id,
              teamId: player.teamId,
              payload: gpsPayload as GpsPayload,
            },
            { db },
          );

          if (isClaimActionBody(result.body) && result.stateVersion) {
            broadcastPayload = {
              gameId: result.gameId,
              stateVersion: result.stateVersion,
              challenge: result.body.challenge,
              claim: result.body.claim,
            };
          }

          return {
            gameId: result.gameId,
            playerId: player.id,
            statusCode: result.statusCode,
            body: result.body,
            responseHeaders: result.responseHeaders ?? {},
          };
        },
        async () => {
          if (!broadcastPayload) {
            return;
          }

          await app.broadcaster.send({
            gameId: broadcastPayload.gameId,
            modeKey: 'territory',
            eventType: socketServerEventTypes.challengeClaimed,
            stateVersion: broadcastPayload.stateVersion,
            payload: {
              challenge: broadcastPayload.challenge,
              claim: broadcastPayload.claim,
            },
          });
        },
      );
    },
  );

  app.post(
    '/challenges/:id/complete',
    {
      preHandler: [app.authenticate, app.requireTeam],
      schema: {
        params: challengeParamsSchema,
        body: completeChallengeBodySchema,
      },
    },
    async (request, reply) => {
      let postCommitData: TerritoryPostCommitData | null = null;

      if (hasGpsPayload(request.body)) {
        await app.validateGps(request, reply);
      }

      await executeIdempotentMutation(
        app,
        request,
        reply,
        async (db) => {
          const player = request.player;

          if (!player?.teamId) {
            throw new Error('Authenticated team player expected.');
          }

          const handler = await getModeHandlerForGame(db, app.modeRegistry, player.gameId);
          const result = await handler.handleAction(
            {
              type: 'complete',
              challengeId: (request.params as { id: string }).id,
              gameId: player.gameId,
              playerId: player.id,
              teamId: player.teamId,
              payload: (request.body as JsonObject | null) ?? null,
            },
            { db },
          );

          postCommitData = isTerritoryPostCommitData(result.postCommitData) ? result.postCommitData : null;

          return {
            gameId: result.gameId,
            playerId: player.id,
            statusCode: result.statusCode,
            body: result.body,
            responseHeaders: result.responseHeaders ?? {},
          };
        },
        async () => {
          if (!postCommitData) {
            return;
          }

          if (postCommitData.type === 'challenge_released') {
            await app.broadcaster.send({
              gameId: postCommitData.gameId,
              modeKey: 'territory',
              eventType: socketServerEventTypes.challengeReleased,
              stateVersion: postCommitData.stateVersion,
              payload: {
                challenge: postCommitData.challenge,
                claim: postCommitData.claim,
              },
            });
            return;
          }

          await app.broadcaster.send({
            gameId: postCommitData.gameId,
            modeKey: 'territory',
            eventType: socketServerEventTypes.challengeCompleted,
            stateVersion: postCommitData.stateVersion,
            payload: {
              challenge: postCommitData.challenge,
              claim: postCommitData.claim,
              zone: postCommitData.zone,
              resourcesAwarded: postCommitData.resourcesAwarded,
            },
          });

          if (postCommitData.zone) {
            await app.broadcaster.send({
              gameId: postCommitData.gameId,
              modeKey: 'territory',
              eventType: socketServerEventTypes.zoneCaptured,
              stateVersion: postCommitData.stateVersion,
              payload: {
                zone: postCommitData.zone,
                challenge: postCommitData.challenge,
                claim: postCommitData.claim,
              },
            });
          }

          for (const entry of postCommitData.resourceEntries) {
            await app.broadcaster.send({
              gameId: postCommitData.gameId,
              modeKey: 'territory',
              eventType: socketServerEventTypes.resourceChanged,
              stateVersion: postCommitData.stateVersion,
              payload: {
                teamId: entry.teamId,
                resourceType: entry.resourceType,
                balance: entry.balanceAfter,
                delta: entry.delta,
                entry,
              },
            });
          }

          await sendZoneCaptureNotifications(app, postCommitData);

          const winConditionResult = await evaluateConfiguredWinConditions(app.db, app.modeRegistry, {
            gameId: postCommitData.gameId,
          });

          if (!winConditionResult.met || !winConditionResult.game || winConditionResult.stateVersion === null) {
            return;
          }

          await app.broadcaster.send({
            gameId: postCommitData.gameId,
            modeKey: winConditionResult.game.modeKey,
            eventType: socketServerEventTypes.gameEnded,
            stateVersion: winConditionResult.stateVersion,
            payload: {
              game: winConditionResult.game,
            },
          });
        },
      );
    },
  );

  app.post(
    '/challenges/:id/release',
    {
      preHandler: [app.authenticate, app.requireTeam],
      schema: {
        params: challengeParamsSchema,
      },
    },
    async (request, reply) => {
      let broadcastPayload:
        | {
            gameId: string;
            stateVersion: number;
            challenge: Challenge;
            claim: ChallengeClaim;
          }
        | null = null;

      await executeIdempotentMutation(
        app,
        request,
        reply,
        async (db) => {
          const player = request.player;

          if (!player?.teamId) {
            throw new Error('Authenticated team player expected.');
          }

          const handler = await getModeHandlerForGame(db, app.modeRegistry, player.gameId);
          const result = await handler.handleAction(
            {
              type: 'release',
              challengeId: (request.params as { id: string }).id,
              gameId: player.gameId,
              playerId: player.id,
              teamId: player.teamId,
            },
            { db },
          );

          if (isClaimActionBody(result.body) && result.stateVersion) {
            broadcastPayload = {
              gameId: result.gameId,
              stateVersion: result.stateVersion,
              challenge: result.body.challenge,
              claim: result.body.claim,
            };
          }

          return {
            gameId: result.gameId,
            playerId: player.id,
            statusCode: result.statusCode,
            body: result.body,
            responseHeaders: result.responseHeaders ?? {},
          };
        },
        async () => {
          if (!broadcastPayload) {
            return;
          }

          await app.broadcaster.send({
            gameId: broadcastPayload.gameId,
            modeKey: 'territory',
            eventType: socketServerEventTypes.challengeReleased,
            stateVersion: broadcastPayload.stateVersion,
            payload: {
              challenge: broadcastPayload.challenge,
              claim: broadcastPayload.claim,
            },
          });
        },
      );
    },
  );
};

function isClaimActionBody(value: unknown): value is {
  challenge: Challenge;
  claim: ChallengeClaim;
  stateVersion: number;
} {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'challenge' in value &&
      'claim' in value &&
      'stateVersion' in value &&
      typeof (value as { stateVersion?: unknown }).stateVersion === 'number',
  );
}

function hasGpsPayload(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }

  return 'gps' in body || 'playerLocation' in body || ('lat' in body && 'lng' in body && 'capturedAt' in body);
}

function isTerritoryPostCommitData(value: unknown): value is TerritoryPostCommitData {
  return Boolean(value && typeof value === 'object' && 'type' in value && 'stateVersion' in value && 'gameId' in value);
}

async function sendZoneCaptureNotifications(app: FastifyInstance, data: Extract<TerritoryPostCommitData, { type: 'challenge_completed' }>) {
  if (!data.zone) {
    return;
  }

  await app.notificationService.sendTeamNotification({
    gameId: data.gameId,
    teamId: data.claim.teamId,
    title: 'Zone captured',
    body: `Your team captured ${data.zone.name}.`,
    priority: 'high',
    meta: {
      zoneId: data.zone.id,
      challengeId: data.challenge.id,
      eventType: 'zone_captured',
    },
  });

  const rivalTeams = await app.db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.gameId, data.gameId), ne(teams.id, data.claim.teamId)));

  for (const team of rivalTeams) {
    await app.notificationService.sendTeamNotification({
      gameId: data.gameId,
      teamId: team.id,
      title: 'Rival zone captured',
      body: `Another team captured ${data.zone.name}.`,
      priority: 'medium',
      meta: {
        zoneId: data.zone.id,
        challengeId: data.challenge.id,
        eventType: 'zone_captured',
      },
    });
  }
}
