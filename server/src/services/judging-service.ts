import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  errorCodes,
  eventTypes,
  getClaimedBonuses,
  getJudgedMaxPoints,
  isJudgedChallengeConfig,
  type GameJudgingSheet,
  type GameJudgingSummary,
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
      submissions: claimRows.filter((claim) => claim.challengeId === row.id).map((claim) => ({
        claimId: claim.id,
        teamId: claim.teamId,
        playerId: claim.playerId,
        submittedAt: (claim.completedAt ?? claim.claimedAt).toISOString(),
        note: getSubmissionNote(claim.submission),
        bonuses: getClaimedBonuses(row.config, claim.submission),
        points: claim.judgedPoints,
      })),
    })),
  };
}

export async function setSubmissionPoints(db: DatabaseClient, claimId: string, points: number | null): Promise<void> {
  const [claim] = await db.select({ id: challengeClaims.id, status: challengeClaims.status }).from(challengeClaims).where(eq(challengeClaims.id, claimId)).limit(1);
  if (!claim || claim.status !== 'submitted') {
    throw new AppError(errorCodes.validationError, { message: 'Judged submission not found.' });
  }
  await db.update(challengeClaims).set({ judgedPoints: points, judgedAt: new Date() }).where(eq(challengeClaims.id, claimId));
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
