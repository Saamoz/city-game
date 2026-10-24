import type { FastifyPluginAsync } from 'fastify';
import { STATE_VERSION_HEADER, socketServerEventTypes, type JsonObject, type JudgingVerdict, type ResourceLedgerEntry } from '@city-game/shared';
import { executeIdempotentMutation } from '../services/idempotency-service.js';
import { getGameById } from '../services/game-service.js';
import { getJudgingSheet, publishJudging, setSubmissionDecision } from '../services/judging-service.js';
import { listBonusTasks, listTeamPointAdjustments, setChallengeBonusesAsAdmin, type ChallengeBonusChangeResult } from '../modes/territory/bonus-service.js';
import { broadcastFullStateToGame } from '../socket/admin-sync.js';

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

// Either a decision ({ verdict, bonusIds?, rejectedBonusIds?, points? }), { decision: null } to clear, or the older { points }.
const decisionBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'winner', 'points'] },
    bonusIds: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    rejectedBonusIds: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    points: { anyOf: [{ type: 'integer', minimum: -100000, maximum: 100000 }, { type: 'null' }] },
    decision: { type: 'null' },
  },
} as const;

export const judgingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/game/:id/judging', { preHandler: [app.requireAdmin], schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.send({ judging: await getJudgingSheet(app.db, id) });
  });

  // Draft scores stay private until published, so this does not touch game state or broadcast.
  app.put('/judging/submissions/:id', { preHandler: [app.requireAdmin], schema: { params: idParamsSchema, body: decisionBodySchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { verdict?: JudgingVerdict; bonusIds?: string[]; rejectedBonusIds?: string[]; points?: number | null; decision?: null };
    const decision = body.verdict
      ? { verdict: body.verdict, bonusIds: body.bonusIds, ...(body.rejectedBonusIds ? { rejectedBonusIds: body.rejectedBonusIds } : {}), ...(typeof body.points === 'number' ? { points: body.points } : {}) }
      : typeof body.points === 'number' ? { verdict: 'points' as const, points: body.points } : null;
    const points = await setSubmissionDecision(app.db, id, decision);
    reply.send({ ok: true, points });
  });

  // Self-reported bonus tasks on completed challenges, which an admin can tick or untick during or
  // after the game. Unlike judged scores these count straight away.
  app.get('/game/:id/bonus-tasks', { preHandler: [app.requireAdmin], schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.send({ tasks: await listBonusTasks(app.db, id) });
  });

  app.get('/game/:id/point-adjustments', { preHandler: [app.requireAdmin], schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.send({ teams: await listTeamPointAdjustments(app.db, id) });
  });

  app.post('/admin/challenges/:id/bonuses', {
    preHandler: [app.requireAdmin],
    schema: {
      params: idParamsSchema,
      body: { type: 'object', additionalProperties: false, required: ['bonusIds'], properties: { bonusIds: { type: 'array', maxItems: 20, items: { type: 'string' } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    let result: ChallengeBonusChangeResult | null = null;
    await executeIdempotentMutation(app, request, reply, async (db) => {
      result = await setChallengeBonusesAsAdmin(db, { challengeId: id, bonusIds: (request.body as { bonusIds: string[] }).bonusIds });
      return {
        gameId: result.gameId,
        statusCode: 200,
        body: { claim: result.claim, entry: result.entry },
        responseHeaders: (result.stateVersion === null ? {} : { [STATE_VERSION_HEADER]: String(result.stateVersion) }) as JsonObject,
      };
    }, async () => {
      const committed = result as ChallengeBonusChangeResult | null;
      if (committed && committed.stateVersion !== null) await broadcastFullStateToGame(app, committed.gameId);
    });
  });

  app.post('/game/:id/judging/publish', { preHandler: [app.requireAdmin], schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    let published: { stateVersion: number; resourceEntries: ResourceLedgerEntry[]; modeKey: string } | null = null;

    await executeIdempotentMutation(app, request, reply, async (db) => {
      const result = await publishJudging(db, id);
      const game = await getGameById(db, id);
      published = { ...result, modeKey: game.modeKey };
      return {
        gameId: id,
        statusCode: 200,
        body: { judging: await getJudgingSheet(db, id), stateVersion: result.stateVersion },
        responseHeaders: { [STATE_VERSION_HEADER]: String(result.stateVersion) },
      };
    }, async () => {
      if (!published) return;
      const { stateVersion, resourceEntries, modeKey } = published;
      for (const entry of resourceEntries) {
        await app.broadcaster.send({
          gameId: id,
          modeKey,
          eventType: socketServerEventTypes.resourceChanged,
          stateVersion,
          payload: { teamId: entry.teamId, resourceType: entry.resourceType, balance: entry.balanceAfter, delta: entry.delta, entry },
        });
      }
    });
  });
};
