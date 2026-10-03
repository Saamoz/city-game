import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  errorCodes,
  eventTypes,
  getBasePoints,
  getChallengeBonuses,
  getClaimedBonuses,
  getJudgedMaxPoints,
  getJudgingType,
  isJudgedChallengeConfig,
  type GameJudgingSheet,
  type GameJudgingSummary,
  type JudgingDecision,
  type JsonObject,
  type JsonValue,
  type ResourceLedgerEntry,
} from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { challengeClaims, challenges, games, resourceLedger } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { serializeChallenge } from '../modes/territory/claim-service.js';
import { appendEvents, type AppendEventInput } from './event-service.js';
import { getGameById, lockGameById } from './game-service.js';
import { transactInTransaction } from './resource-service.js';

// Judged challenges: teams submit during the game (status 'submitted' claims), judges enter draft
// points on each submission at any time, and publishing after the game turns those drafts into
// ledger entries. Publishing writes deltas, so judges can correct a score and publish again.

const JUDGED_AWARD_REASON = 'judged_award';

export async function getJudgingSheet(db: DatabaseClient, gameId: string): Promise<GameJudgingSheet> {
  const game = await getGameById(db, gameId);
  const challengeRows = (await db.select().from(challenges).where(eq(challenges.gameId, gameId)).orderBy(asc(challenges.sortOrder), asc(challenges.createdAt)))
    .filter((row) => isJudgedChallengeConfig(row.config));
  const claimRows = challengeRows.length
    ? await db.select().from(challengeClaims)
      .where(and(inArray(challengeClaims.challengeId, challengeRows.map((row) => row.id)), eq(challengeClaims.status, 'submitted')))
      .orderBy(asc(challengeClaims.completedAt))
    : [];

  return {
    gameId,
    publishedAt: getPublishedAt(game.settings),
    challenges: challengeRows.map((row) => ({
      challenge: serializeChallenge(row),
      maxPoints: getJudgedMaxPoints(row.config),
      judgingType: getJudgingType(row.config),
      basePoints: getBasePoints(row.scoring),
      bonuses: getChallengeBonuses(row.config),
      submissions: claimRows.filter((claim) => claim.challengeId === row.id).map((claim) => ({
        claimId: claim.id,
        teamId: claim.teamId,
        playerId: claim.playerId,
        submittedAt: (claim.completedAt ?? claim.claimedAt).toISOString(),
        note: getSubmissionNote(claim.submission),
        bonuses: getClaimedBonuses(row.config, claim.submission),
        points: claim.judgedPoints,
        decision: (claim.judgedDecision as JudgingDecision | null) ?? null,
      })),
    })),
  };
}

// Records the judge's decision and stores the points it is worth. Null clears the decision.
export async function setSubmissionDecision(db: DatabaseClient, claimId: string, decision: JudgingDecision | null): Promise<number | null> {
  const [row] = await db.select({ claim: challengeClaims, challenge: challenges })
    .from(challengeClaims).innerJoin(challenges, eq(challenges.id, challengeClaims.challengeId))
    .where(eq(challengeClaims.id, claimId)).limit(1);
  if (!row || row.claim.status !== 'submitted') {
    throw new AppError(errorCodes.validationError, { message: 'Judged submission not found.' });
  }
  const points = decision ? computeDecisionPoints(row.challenge, decision) : null;
  const stored = decision ? { ...decision, bonusIds: getChallengeBonuses(row.challenge.config).filter((bonus) => decision.bonusIds?.includes(bonus.id)).map((bonus) => bonus.id) } : null;
  await db.update(challengeClaims).set({ judgedPoints: points, judgedDecision: stored, judgedAt: new Date() }).where(eq(challengeClaims.id, claimId));
  return points;
}

function computeDecisionPoints(challenge: typeof challenges.$inferSelect, decision: JudgingDecision): number {
  const type = getJudgingType(challenge.config);
  const base = getBasePoints(challenge.scoring);
  const approvedBonus = getChallengeBonuses(challenge.config).filter((bonus) => decision.bonusIds?.includes(bonus.id)).reduce((total, bonus) => total + bonus.points, 0);
  if (type === 'points' || decision.verdict === 'points') {
    if (typeof decision.points !== 'number' || !Number.isFinite(decision.points)) throw new AppError(errorCodes.validationError, { message: 'Enter the points to award.' });
    return Math.round(decision.points);
  }
  if (type === 'best_wins') {
    if (decision.verdict !== 'winner' && decision.verdict !== 'fail') throw new AppError(errorCodes.validationError, { message: 'Pick this team as a winner or not.' });
    return decision.verdict === 'winner' ? base + approvedBonus : 0;
  }
  if (decision.verdict !== 'pass' && decision.verdict !== 'fail') throw new AppError(errorCodes.validationError, { message: 'Mark this submission as yes or no.' });
  return decision.verdict === 'pass' ? base + approvedBonus : 0;
}

export async function publishJudging(db: DatabaseClient, gameId: string, now = new Date()): Promise<{ stateVersion: number; resourceEntries: ResourceLedgerEntry[] }> {
  const game = await lockGameById(db, gameId);
  if (game.status !== 'completed') {
    throw new AppError(errorCodes.invalidGameStateTransition, { message: 'Judged scores can be published once the game has ended.', details: { currentStatus: game.status } });
  }

  const claims = await db.select().from(challengeClaims).where(and(eq(challengeClaims.gameId, gameId), eq(challengeClaims.status, 'submitted')));
  const awardedRows = claims.length
    ? await db.select({ referenceId: resourceLedger.referenceId, total: sql<number>`COALESCE(SUM(${resourceLedger.delta}), 0)::int` })
      .from(resourceLedger)
      .where(and(eq(resourceLedger.gameId, gameId), eq(resourceLedger.reason, JUDGED_AWARD_REASON)))
      .groupBy(resourceLedger.referenceId)
    : [];
  const awardedByClaimId = new Map(awardedRows.map((row) => [row.referenceId, Number(row.total)]));

  const resourceEntries: ResourceLedgerEntry[] = [];
  for (const claim of claims) {
    const delta = (claim.judgedPoints ?? 0) - (awardedByClaimId.get(claim.id) ?? 0);
    if (delta === 0) continue;
    resourceEntries.push(await transactInTransaction(db, {
      gameId,
      teamId: claim.teamId,
      resourceType: 'points',
      delta,
      reason: JUDGED_AWARD_REASON,
      referenceId: claim.id,
      referenceType: 'challenge_claim',
      allowNegative: true,
    }));
  }

  await db.update(games).set({ settings: { ...(game.settings as JsonObject), judging_published_at: now.toISOString() }, updatedAt: now }).where(eq(games.id, gameId));

  const events: AppendEventInput[] = resourceEntries.map((entry) => ({
    eventType: eventTypes.resourceChanged,
    entityType: 'resource_ledger',
    entityId: entry.id,
    actorType: 'admin',
    actorId: null,
    actorTeamId: entry.teamId,
    afterState: entry as unknown as JsonValue,
    meta: { entry, judged: true } as unknown as JsonObject,
  }));
  if (events.length === 0) {
    events.push({ eventType: eventTypes.resourceChanged, entityType: 'game', entityId: gameId, actorType: 'admin', actorId: null, actorTeamId: null, meta: { judged: true, entries: [] } as unknown as JsonObject });
  }
  const { stateVersion } = await appendEvents(db, { gameId, events });
  return { stateVersion, resourceEntries };
}

export async function getJudgingSummary(db: DatabaseClient, gameId: string, settings: unknown): Promise<GameJudgingSummary> {
  const challengeRows = await db.select({ config: challenges.config }).from(challenges).where(eq(challenges.gameId, gameId));
  if (!challengeRows.some((row) => isJudgedChallengeConfig(row.config))) {
    return { status: 'none', submissionCount: 0, publishedAt: null };
  }
  const [countRow] = await db.select({ count: sql<number>`COUNT(*)::int` }).from(challengeClaims)
    .where(and(eq(challengeClaims.gameId, gameId), eq(challengeClaims.status, 'submitted')));
  const publishedAt = getPublishedAt(settings);
  return { status: publishedAt ? 'published' : 'pending', submissionCount: Number(countRow?.count ?? 0), publishedAt };
}

function getPublishedAt(settings: unknown): string | null {
  const value = settings && typeof settings === 'object' ? (settings as JsonObject).judging_published_at : null;
  return typeof value === 'string' ? value : null;
}

function getSubmissionNote(submission: unknown): string | null {
  if (typeof submission === 'string') return submission.trim() || null;
  if (submission && typeof submission === 'object' && !Array.isArray(submission)) {
    const note = (submission as { note?: unknown }).note;
    return typeof note === 'string' && note.trim() ? note.trim() : null;
  }
  return null;
}
