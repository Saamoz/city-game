import type { FastifyPluginAsync } from 'fastify';
import { STATE_VERSION_HEADER, socketServerEventTypes, type JudgingVerdict, type ResourceLedgerEntry } from '@city-game/shared';
import { executeIdempotentMutation } from '../services/idempotency-service.js';
import { getGameById } from '../services/game-service.js';
import { getJudgingSheet, publishJudging, setSubmissionDecision } from '../services/judging-service.js';

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

// Either a decision ({ verdict, bonusIds?, points? }), { decision: null } to clear, or the older { points }.
const decisionBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'winner', 'points'] },
    bonusIds: { type: 'array', items: { type: 'string' }, maxItems: 10 },
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
    const body = request.body as { verdict?: JudgingVerdict; bonusIds?: string[]; points?: number | null; decision?: null };
    const decision = body.verdict
      ? { verdict: body.verdict, bonusIds: body.bonusIds, ...(typeof body.points === 'number' ? { points: body.points } : {}) }
      : typeof body.points === 'number' ? { verdict: 'points' as const, points: body.points } : null;
    const points = await setSubmissionDecision(app.db, id, decision);
    reply.send({ ok: true, points });
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
