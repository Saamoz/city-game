import { and, eq, isNotNull } from 'drizzle-orm';
import {
  errorCodes,
  eventTypes,
  type Challenge,
  type ChallengeRerollState,
  type GameSettings,
  type JsonObject,
} from '@city-game/shared';
import type { DatabaseClient } from '../../db/connection.js';
import { challengeRerollVotes, challenges, games, players } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { appendEvents } from '../../services/event-service.js';
import { serializeChallenge } from './claim-service.js';
import { activateNextQueuedChallenge, findNextQueuedChallenge } from './deck-service.js';

export const DEFAULT_REROLL_COMPLETION_TARGET = 2;

export interface ToggleChallengeRerollVoteInput {
  gameId: string;
  challengeId: string;
  playerId: string;
  teamId: string;
}

export interface ToggleChallengeRerollVoteResult {
  gameId: string;
  stateVersion: number;
  rerollState: ChallengeRerollState;
  challenge: Challenge;
  activatedChallenge: Challenge | null;
  didReroll: boolean;
}

export function getRerollCompletionTarget(settings: GameSettings): number {
  const configured = settings.reroll_completion_target;
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : DEFAULT_REROLL_COMPLETION_TARGET;
}

export async function getChallengeRerollState(
  db: DatabaseClient,
  gameId: string,
): Promise<ChallengeRerollState> {
  const [game] = await db
    .select({
      rerollAvailable: games.rerollAvailable,
      rerollCompletionProgress: games.rerollCompletionProgress,
      settings: games.settings,
    })
    .from(games)
    .where(eq(games.id, gameId))
    .limit(1);

  if (!game) throw new AppError(errorCodes.gameNotFound);

  const eligibleTeamIds = await getEligibleTeamIds(db, gameId);
  const voteRows = await db
    .select({ challengeId: challengeRerollVotes.challengeId, teamId: challengeRerollVotes.teamId })
    .from(challengeRerollVotes)
    .where(eq(challengeRerollVotes.gameId, gameId));
  const [nextQueued] = await db
    .select({ id: challenges.id })
    .from(challenges)
    .where(and(eq(challenges.gameId, gameId), eq(challenges.status, 'available'), eq(challenges.isDeckActive, false)))
    .limit(1);

  const eligibleSet = new Set(eligibleTeamIds);
  const teamIdsByChallenge = new Map<string, string[]>();
  for (const vote of voteRows) {
    if (!eligibleSet.has(vote.teamId)) continue;
    const teamIds = teamIdsByChallenge.get(vote.challengeId) ?? [];
    teamIds.push(vote.teamId);
    teamIdsByChallenge.set(vote.challengeId, teamIds);
  }

  return {
    isAvailable: game.rerollAvailable && Boolean(nextQueued) && eligibleTeamIds.length > 0,
    completionProgress: game.rerollCompletionProgress,
    completionTarget: getRerollCompletionTarget(game.settings as GameSettings),
    eligibleTeamCount: eligibleTeamIds.length,
    votes: [...teamIdsByChallenge.entries()].map(([challengeId, teamIds]) => ({ challengeId, teamIds })),
  };
}

export async function advanceChallengeRerollCharge(
  db: DatabaseClient,
  input: { gameId: string; completedChallengeId: string; settings: GameSettings },
): Promise<ChallengeRerollState> {
  const [game] = await db.select().from(games).where(eq(games.id, input.gameId)).limit(1).for('update');
  if (!game) throw new AppError(errorCodes.gameNotFound);

  await db.delete(challengeRerollVotes).where(eq(challengeRerollVotes.challengeId, input.completedChallengeId));

  if (!game.rerollAvailable) {
    const target = getRerollCompletionTarget(input.settings);
    const nextProgress = game.rerollCompletionProgress + 1;
    await db
      .update(games)
      .set({
        rerollAvailable: nextProgress >= target,
        rerollCompletionProgress: nextProgress >= target ? 0 : nextProgress,
      })
      .where(eq(games.id, input.gameId));
  }

  return getChallengeRerollState(db, input.gameId);
}

export async function toggleChallengeRerollVote(
  db: DatabaseClient,
  input: ToggleChallengeRerollVoteInput,
): Promise<ToggleChallengeRerollVoteResult> {
  const [game] = await db.select().from(games).where(eq(games.id, input.gameId)).limit(1).for('update');
  if (!game) throw new AppError(errorCodes.gameNotFound);
  if (game.status !== 'active') throw new AppError(errorCodes.gameNotActive);
  if (!game.rerollAvailable) {
    throw new AppError(errorCodes.validationError, { message: 'A shared reroll is not available yet.' });
  }

  const [challenge] = await db.select().from(challenges).where(eq(challenges.id, input.challengeId)).limit(1).for('update');
  if (!challenge || challenge.gameId !== input.gameId || challenge.status !== 'available' || !challenge.isDeckActive) {
    throw new AppError(errorCodes.challengeNotAvailable);
  }

  const eligibleTeamIds = await getEligibleTeamIds(db, input.gameId);
  if (!eligibleTeamIds.includes(input.teamId)) throw new AppError(errorCodes.notOnTeam);

  const [existingVote] = await db
    .select({ id: challengeRerollVotes.id })
    .from(challengeRerollVotes)
    .where(and(eq(challengeRerollVotes.challengeId, input.challengeId), eq(challengeRerollVotes.teamId, input.teamId)))
    .limit(1);

  let updatedChallengeRow = challenge;
  let activatedChallengeRow: typeof challenges.$inferSelect | null = null;
  let didReroll = false;

  if (existingVote) {
    await db.delete(challengeRerollVotes).where(eq(challengeRerollVotes.id, existingVote.id));
  } else {
    const nextQueued = await findNextQueuedChallenge(db, input.gameId);
    if (!nextQueued) {
      throw new AppError(errorCodes.validationError, { message: 'No replacement challenge is available.' });
    }

    await db.insert(challengeRerollVotes).values({
      gameId: input.gameId,
      challengeId: input.challengeId,
      teamId: input.teamId,
    });

    const voteRows = await db
      .select({ teamId: challengeRerollVotes.teamId })
      .from(challengeRerollVotes)
      .where(eq(challengeRerollVotes.challengeId, input.challengeId));
    const eligibleSet = new Set(eligibleTeamIds);
    const voteCount = new Set(voteRows.map((vote) => vote.teamId).filter((teamId) => eligibleSet.has(teamId))).size;

    if (voteCount >= eligibleTeamIds.length) {
      const now = new Date();
      [updatedChallengeRow] = await db
        .update(challenges)
        .set({ status: 'skipped', isDeckActive: false, updatedAt: now })
        .where(eq(challenges.id, challenge.id))
        .returning();
      activatedChallengeRow = await activateNextQueuedChallenge(db, input.gameId, now);
      await db.update(games).set({ rerollAvailable: false, rerollCompletionProgress: 0 }).where(eq(games.id, input.gameId));
      await db.delete(challengeRerollVotes).where(eq(challengeRerollVotes.gameId, input.gameId));
      didReroll = true;
    }
  }

  const rerollState = await getChallengeRerollState(db, input.gameId);
  const serializedChallenge = serializeChallenge(updatedChallengeRow);
  const activatedChallenge = activatedChallengeRow ? serializeChallenge(activatedChallengeRow) : null;
  const { stateVersion } = await appendEvents(db, {
    gameId: input.gameId,
    events: [{
      eventType: eventTypes.challengeRerollStateChanged,
      entityType: 'challenge',
      entityId: input.challengeId,
      actorType: 'player',
      actorId: input.playerId,
      actorTeamId: input.teamId,
      afterState: { didReroll, rerollState } as unknown as JsonObject,
      meta: { rerollState, challenge: serializedChallenge, activatedChallenge } as unknown as JsonObject,
    }],
  });

  return {
    gameId: input.gameId,
    stateVersion,
    rerollState,
    challenge: serializedChallenge,
    activatedChallenge,
    didReroll,
  };
}

async function getEligibleTeamIds(db: DatabaseClient, gameId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ teamId: players.teamId })
    .from(players)
    .where(and(eq(players.gameId, gameId), isNotNull(players.teamId)));
  return rows.flatMap((row) => row.teamId ? [row.teamId] : []);
}
