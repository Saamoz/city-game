import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  errorCodes,
  eventTypes,
  getClaimedBonuses,
  getSelfReportedBonuses,
  isJudgedChallengeConfig,
  sumBonusPoints,
  type Challenge,
  type ChallengeBonus,
  type ChallengeClaim,
  type JsonObject,
  type JsonValue,
  type ResourceLedgerEntry,
} from '@city-game/shared';
import type { DatabaseClient } from '../../db/connection.js';
import { challengeClaims, challenges, resourceLedger } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { appendEvents } from '../../services/event-service.js';
import { lockGameById } from '../../services/game-service.js';
import { transactInTransaction } from '../../services/resource-service.js';
import { lockChallenge, serializeChallenge, serializeClaim } from './claim-service.js';

export interface ChallengeBonusChangeResult {
  gameId: string;
  stateVersion: number | null;
  claim: ChallengeClaim;
  entry: ResourceLedgerEntry | null;
}

export interface BonusTask {
  challenge: Challenge;
  bonuses: ChallengeBonus[];
  completion: { claimId: string; teamId: string; bonusIds: string[] } | null;
}

// Bonus tasks ticked after a challenge was completed: the completing team adds ones it did later
// (or forgot to tick) while the game is live, and an admin can tick or untick any of them from the
// judging page during or after the game. Only self-reported bonuses: judged ones go through judging.
// The points go on the ledger straight away as challenge_completed for the challenge, so an admin
// Reopen takes them back too.

export async function addChallengeBonuses(
  db: DatabaseClient,
  input: { challengeId: string; gameId: string; playerId: string; teamId: string; bonusIds: string[] },
): Promise<ChallengeBonusChangeResult> {
  const game = await lockGameById(db, input.gameId);
  if (game.status !== 'active') {
    throw new AppError(errorCodes.gameNotActive, { details: { gameId: game.id, status: game.status } });
  }
  const { challenge, claim } = await lockCompletedChallenge(db, input.challengeId, input.gameId);
  if (claim.teamId !== input.teamId) {
    throw new AppError(errorCodes.claimNotYours, { message: 'Only the team that completed this challenge can add its bonuses.' });
  }
  assertKnownBonuses(challenge, input.bonusIds);

  // Players can only add: bonuses already counted stay, so a repeat is harmless.
  const current = getClaimedBonuses(challenge.config, claim.submission).map((bonus) => bonus.id);
  return applyBonusChange(db, { gameId: input.gameId, challenge, claim, nextIds: [...new Set([...current, ...input.bonusIds])], actor: { type: 'player', id: input.playerId, teamId: input.teamId } });
}

export async function setChallengeBonusesAsAdmin(db: DatabaseClient, input: { challengeId: string; bonusIds: string[] }): Promise<ChallengeBonusChangeResult> {
  const [row] = await db.select({ gameId: challenges.gameId }).from(challenges).where(eq(challenges.id, input.challengeId)).limit(1);
  if (!row) {
    throw new AppError(errorCodes.validationError, { message: 'Challenge not found.' });
  }
  const game = await lockGameById(db, row.gameId);
  if (game.status === 'setup') {
    throw new AppError(errorCodes.validationError, { message: 'The game has not started yet.' });
  }
  const { challenge, claim } = await lockCompletedChallenge(db, input.challengeId, game.id);
  assertKnownBonuses(challenge, input.bonusIds);
  return applyBonusChange(db, { gameId: game.id, challenge, claim, nextIds: input.bonusIds, actor: { type: 'admin', id: null, teamId: null } });
}

// Every completed regular challenge with self-reported bonuses, with the team that did it and the
// bonuses it has ticked, for the judging page.
export async function listBonusTasks(db: DatabaseClient, gameId: string): Promise<BonusTask[]> {
  const rows = (await db.select().from(challenges).where(eq(challenges.gameId, gameId)).orderBy(asc(challenges.sortOrder), asc(challenges.createdAt)))
    .filter((row) => !isJudgedChallengeConfig(row.config) && getSelfReportedBonuses(row.config).length > 0);
  const claims = rows.length
    ? await db.select().from(challengeClaims)
      .where(and(inArray(challengeClaims.challengeId, rows.map((row) => row.id)), eq(challengeClaims.status, 'completed')))
      .orderBy(desc(challengeClaims.completedAt))
    : [];
  return rows.map((row) => {
    const claim = row.status === 'completed' ? claims.find((entry) => entry.challengeId === row.id) : undefined;
    const bonuses = getSelfReportedBonuses(row.config);
    return {
      challenge: serializeChallenge(row),
      bonuses,
      completion: claim
        ? { claimId: claim.id, teamId: claim.teamId, bonusIds: getClaimedBonuses(row.config, claim.submission).filter((bonus) => !bonus.judged).map((bonus) => bonus.id) }
        : null,
    };
  });
}

// Each team's points and how much of that came from admin adjustments (the judging page's +/- counter,
// which posts to /admin/resources/adjust and records reason admin_adjustment).
export async function listTeamPointAdjustments(db: DatabaseClient, gameId: string): Promise<Array<{ teamId: string; points: number; adjustment: number }>> {
  const rows = await db
    .select({
      teamId: resourceLedger.teamId,
      points: sql<number>`COALESCE(SUM(${resourceLedger.delta}), 0)::int`,
      adjustment: sql<number>`COALESCE(SUM(${resourceLedger.delta}) FILTER (WHERE ${resourceLedger.reason} = 'admin_adjustment'), 0)::int`,
    })
    .from(resourceLedger)
    .where(and(eq(resourceLedger.gameId, gameId), eq(resourceLedger.resourceType, 'points')))
    .groupBy(resourceLedger.teamId);
  return rows.filter((row): row is { teamId: string; points: number; adjustment: number } => Boolean(row.teamId))
    .map((row) => ({ teamId: row.teamId, points: Number(row.points), adjustment: Number(row.adjustment) }));
}

async function lockCompletedChallenge(db: DatabaseClient, challengeId: string, gameId: string) {
  const challenge = await lockChallenge(db, challengeId);
  if (challenge.gameId !== gameId) {
    throw new AppError(errorCodes.validationError, { message: 'Challenge not found for this game.' });
  }
  const notCompleted = () => new AppError(errorCodes.validationError, { message: 'Bonuses can only be added to a completed challenge.' });
  if (challenge.status !== 'completed' || isJudgedChallengeConfig(challenge.config)) {
    throw notCompleted();
  }
  const [claim] = await db
    .select()
    .from(challengeClaims)
    .where(and(eq(challengeClaims.challengeId, challenge.id), eq(challengeClaims.status, 'completed')))
    .orderBy(desc(challengeClaims.completedAt))
    .limit(1)
    .for('update');
  if (!claim) {
    throw notCompleted();
  }
  return { challenge, claim };
}

function assertKnownBonuses(challenge: typeof challenges.$inferSelect, bonusIds: string[]) {
  const available = getSelfReportedBonuses(challenge.config);
  const unknownIds = bonusIds.filter((id) => !available.some((bonus) => bonus.id === id));
  if (unknownIds.length) {
    throw new AppError(errorCodes.validationError, { message: 'That bonus is not part of this challenge.', details: { bonusIds: unknownIds } });
  }
}

// Sets the claim's self-reported bonuses to nextIds and puts the difference in points on the ledger.
async function applyBonusChange(
  db: DatabaseClient,
  input: {
    gameId: string;
    challenge: typeof challenges.$inferSelect;
    claim: typeof challengeClaims.$inferSelect;
    nextIds: string[];
    actor: { type: 'player' | 'admin'; id: string | null; teamId: string | null };
  },
): Promise<ChallengeBonusChangeResult> {
  const selfReported = getSelfReportedBonuses(input.challenge.config);
  const before = getClaimedBonuses(input.challenge.config, input.claim.submission).filter((bonus) => !bonus.judged);
  const after = selfReported.filter((bonus) => input.nextIds.includes(bonus.id));
  if (before.length === after.length && before.every((bonus) => after.some((entry) => entry.id === bonus.id))) {
    return { gameId: input.gameId, stateVersion: null, claim: serializeClaim(input.claim), entry: null };
  }

  // Keep anything else on the submission (a note, judged bonus ids the team ticked) as it was.
  const submission = input.claim.submission && typeof input.claim.submission === 'object' && !Array.isArray(input.claim.submission) ? input.claim.submission as JsonObject : {};
  const previousIds = Array.isArray(submission.bonusIds) ? submission.bonusIds.filter((id): id is string => typeof id === 'string') : [];
  const selfIds = new Set(selfReported.map((bonus) => bonus.id));
  const nextSubmission: JsonObject = { ...submission, bonusIds: [...previousIds.filter((id) => !selfIds.has(id)), ...after.map((bonus) => bonus.id)] };
  const [updatedClaim] = await db.update(challengeClaims).set({ submission: nextSubmission }).where(eq(challengeClaims.id, input.claim.id)).returning();
  if (!updatedClaim) {
    throw new AppError(errorCodes.validationError, { message: 'Updating the bonuses failed.' });
  }

  const delta = sumBonusPoints(after) - sumBonusPoints(before);
  const entry = delta === 0 ? null : await transactInTransaction(db, {
    gameId: input.gameId,
    teamId: input.claim.teamId,
    resourceType: 'points',
    delta,
    reason: 'challenge_completed',
    referenceId: input.challenge.id,
    referenceType: 'challenge',
    allowNegative: true,
  });

  const serializedClaim = serializeClaim(updatedClaim);
  const { stateVersion } = await appendEvents(db, {
    gameId: input.gameId,
    events: [
      {
        eventType: eventTypes.objectiveStateChanged,
        entityType: 'challenge_claim',
        entityId: updatedClaim.id,
        actorType: input.actor.type,
        actorId: input.actor.id,
        actorTeamId: input.actor.teamId,
        beforeState: serializeClaim(input.claim) as unknown as JsonValue,
        afterState: serializedClaim as unknown as JsonValue,
        meta: { challenge: serializeChallenge(input.challenge), claim: serializedClaim, bonusIds: after.map((bonus) => bonus.id) } as unknown as JsonObject,
      },
      ...(entry ? [{
        eventType: eventTypes.resourceChanged,
        entityType: 'resource_ledger' as const,
        entityId: entry.id,
        actorType: input.actor.type,
        actorId: input.actor.id,
        actorTeamId: input.actor.teamId,
        afterState: entry as unknown as JsonValue,
        meta: { entry } as unknown as JsonObject,
      }] : []),
    ],
  });

  return { gameId: input.gameId, stateVersion, claim: serializedClaim, entry };
}
