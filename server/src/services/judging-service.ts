import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import {
  errorCodes,
  eventTypes,
  getBasePoints,
  getChallengeBonuses,
  getClaimedBonuses,
  getJudgedBonuses,
  getJudgedMaxPoints,
  getJudgingType,
  isJudgedBonusDecisionComplete,
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

// Judged challenges are yes/no bonuses: teams complete them like any challenge (status 'submitted'
// claims), the admin judges each one at any time, and publishing after the game turns the decisions
// into ledger entries. Players see a waiting screen instead of the results until then. A game whose
// submissions are all decided by the time it ends publishes on its own. Publishing writes deltas, so
// a judge can correct a decision and publish again.
//
// Regular challenges can also carry judged bonuses (e.g. "offer it to Sagnik"): the completing team
// scores the base points live, and the judge later marks each judged bonus yes or no on that
// team's completed claim. Those decisions publish the same way.

const JUDGED_AWARD_REASON = 'judged_award';

export async function getJudgingSheet(db: DatabaseClient, gameId: string): Promise<GameJudgingSheet> {
  const game = await getGameById(db, gameId);
  const challengeRows = (await db.select().from(challenges).where(eq(challenges.gameId, gameId)).orderBy(asc(challenges.sortOrder), asc(challenges.createdAt)))
    .filter((row) => getJudgingKind(row.config) !== null);
  const claimRows = challengeRows.length
    ? (await db.select().from(challengeClaims)
      .where(and(inArray(challengeClaims.challengeId, challengeRows.map((row) => row.id)), inArray(challengeClaims.status, ['submitted', 'completed'])))
      .orderBy(asc(challengeClaims.completedAt)))
      .filter((claim) => claim.status === JUDGEABLE_CLAIM_STATUS[getJudgingKind(challengeRows.find((row) => row.id === claim.challengeId)!.config)!])
    : [];

  return {
    gameId,
    publishedAt: getPublishedAt(game.settings),
    challenges: challengeRows.map((row) => ({
      challenge: serializeChallenge(row),
      maxPoints: getJudgedMaxPoints(row.config),
      judgingType: getJudgingKind(row.config) === 'bonus' ? 'bonus' as const : getJudgingType(row.config),
      basePoints: getBasePoints(row.scoring),
      bonuses: getJudgingKind(row.config) === 'bonus' ? getJudgedBonuses(row.config) : getChallengeBonuses(row.config),
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
  const kind = row ? getJudgingKind(row.challenge.config) : null;
  if (!row || !kind || row.claim.status !== JUDGEABLE_CLAIM_STATUS[kind]) {
    throw new AppError(errorCodes.validationError, { message: 'Judged submission not found.' });
  }
  const points = decision ? computeDecisionPoints(row.challenge, decision) : null;
  const bonusIds = getChallengeBonuses(row.challenge.config).map((bonus) => bonus.id);
  const stored = decision
    ? {
      ...decision,
      bonusIds: bonusIds.filter((id) => decision.bonusIds?.includes(id)),
      ...(decision.rejectedBonusIds ? { rejectedBonusIds: bonusIds.filter((id) => decision.rejectedBonusIds?.includes(id) && !decision.bonusIds?.includes(id)) } : {}),
    }
    : null;
  await db.update(challengeClaims).set({ judgedPoints: points, judgedDecision: stored, judgedAt: new Date() }).where(eq(challengeClaims.id, claimId));
  return points;
}

function computeDecisionPoints(challenge: typeof challenges.$inferSelect, decision: JudgingDecision): number {
  // A regular challenge's base points already scored, so only its approved judged bonuses count.
  if (getJudgingKind(challenge.config) === 'bonus') {
    return getJudgedBonuses(challenge.config).filter((bonus) => decision.bonusIds?.includes(bonus.id)).reduce((total, bonus) => total + bonus.points, 0);
  }
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

  const awardedRows = await db.select({ referenceId: resourceLedger.referenceId, total: sql<number>`COALESCE(SUM(${resourceLedger.delta}), 0)::int` })
    .from(resourceLedger)
    .where(and(eq(resourceLedger.gameId, gameId), eq(resourceLedger.reason, JUDGED_AWARD_REASON)))
    .groupBy(resourceLedger.referenceId);
  const awardedClaimIds = awardedRows.map((row) => row.referenceId).filter((id): id is string => Boolean(id));
  // Judged-challenge submissions, regular claims a judge decided judged bonuses on, and claims
  // already awarded (so clearing a decision takes its points back).
  const claims = await db.select().from(challengeClaims)
    .where(and(
      eq(challengeClaims.gameId, gameId),
      or(
        eq(challengeClaims.status, 'submitted'),
        isNotNull(challengeClaims.judgedPoints),
        ...(awardedClaimIds.length ? [inArray(challengeClaims.id, awardedClaimIds)] : []),
      ),
    ));
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

// Called when a game ends: publishes straight away when nothing is left to judge, so players only
// wait for the judges when there is something to wait for.
export async function publishJudgingIfDecided(db: DatabaseClient, gameId: string, now = new Date()): Promise<boolean> {
  const challengeRows = await db.select({ config: challenges.config }).from(challenges).where(eq(challenges.gameId, gameId));
  if (!challengeRows.some((row) => getJudgingKind(row.config) !== null)) return false;
  const judgeable = await listJudgeableClaims(db, gameId);
  if (judgeable.some((entry) => !entry.decided)) return false;
  await publishJudging(db, gameId, now);
  return true;
}

export async function getJudgingSummary(db: DatabaseClient, gameId: string, settings: unknown): Promise<GameJudgingSummary> {
  const challengeRows = await db.select({ config: challenges.config }).from(challenges).where(eq(challenges.gameId, gameId));
  if (!challengeRows.some((row) => getJudgingKind(row.config) !== null)) {
    return { status: 'none', submissionCount: 0, publishedAt: null };
  }
  const submissionCount = (await listJudgeableClaims(db, gameId)).length;
  const publishedAt = getPublishedAt(settings);
  // Nothing was submitted, so there is nothing to wait for.
  if (submissionCount === 0 && !publishedAt) {
    return { status: 'none', submissionCount: 0, publishedAt: null };
  }
  return { status: publishedAt ? 'published' : 'pending', submissionCount, publishedAt };
}

// 'challenge': the whole challenge is judged (claims are 'submitted'). 'bonus': a regular challenge
// with judged bonuses (claims are 'completed'). Null: nothing to judge.
type JudgingKind = 'challenge' | 'bonus';
const JUDGEABLE_CLAIM_STATUS: Record<JudgingKind, string> = { challenge: 'submitted', bonus: 'completed' };

function getJudgingKind(config: unknown): JudgingKind | null {
  if (isJudgedChallengeConfig(config)) return 'challenge';
  return getJudgedBonuses(config).length > 0 ? 'bonus' : null;
}

export function hasJudging(config: unknown): boolean {
  return getJudgingKind(config) !== null;
}

// Every claim a judge has to look at, and whether it has a full decision yet.
async function listJudgeableClaims(db: DatabaseClient, gameId: string): Promise<Array<{ claimId: string; decided: boolean }>> {
  const rows = await db.select({ claim: challengeClaims, config: challenges.config })
    .from(challengeClaims).innerJoin(challenges, eq(challenges.id, challengeClaims.challengeId))
    .where(and(eq(challengeClaims.gameId, gameId), inArray(challengeClaims.status, ['submitted', 'completed'])));
  return rows.flatMap(({ claim, config }) => {
    const kind = getJudgingKind(config);
    if (!kind || claim.status !== JUDGEABLE_CLAIM_STATUS[kind]) return [];
    const decision = claim.judgedDecision as JudgingDecision | null;
    return [{ claimId: claim.id, decided: kind === 'bonus' ? isJudgedBonusDecisionComplete(config, decision) : decision !== null }];
  });
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
