import { and, eq } from 'drizzle-orm';
import {
  errorCodes,
  eventTypes,
  type Challenge,
  type ChallengeClaim,
  type JsonObject,
  type JsonValue,
} from '@city-game/shared';
import type { DatabaseClient } from '../../db/connection.js';
import { challengeClaims, challenges } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { appendEvents } from '../../services/event-service.js';
import { getGameById } from '../../services/game-service.js';
import { isPortableChallengeConfig, lockChallenge, serializeChallenge, serializeClaim } from './claim-service.js';

const ACTIVE_CLAIM_STATUS = 'active';

export interface ReleaseChallengeInput {
  challengeId: string;
  gameId: string;
  playerId: string;
  teamId: string;
}

export interface ReleaseChallengeResult {
  gameId: string;
  stateVersion: number;
  challenge: Challenge;
  claim: ChallengeClaim;
}

export async function releaseChallenge(db: DatabaseClient, input: ReleaseChallengeInput): Promise<ReleaseChallengeResult> {
  const game = await getGameById(db, input.gameId);

  if (game.status !== 'active') {
    throw new AppError(errorCodes.gameNotActive, {
      details: {
        gameId: game.id,
        status: game.status,
      },
    });
  }

  const now = new Date();
  const lockedChallenge = await lockChallenge(db, input.challengeId);

  if (lockedChallenge.gameId !== input.gameId) {
    throw new AppError(errorCodes.validationError, {
      message: 'Challenge not found for the active player game.',
    });
  }

  const lockedClaim = await lockActiveClaim(db, lockedChallenge);

  if (lockedClaim.teamId !== input.teamId) {
    throw new AppError(errorCodes.claimNotYours);
  }

  const [updatedClaim] = await db
    .update(challengeClaims)
    .set({
      status: 'released',
      releasedAt: now,
    })
    .where(and(eq(challengeClaims.id, lockedClaim.id), eq(challengeClaims.status, ACTIVE_CLAIM_STATUS)))
    .returning();

  if (!updatedClaim) {
    throw new AppError(errorCodes.noActiveClaim);
  }

  const [updatedChallenge] = await db
    .update(challenges)
    .set({
      zoneId: isPortableChallengeConfig(lockedChallenge.config) ? null : lockedChallenge.zoneId,
      status: 'available',
      currentClaimId: null,
      expiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(challenges.id, lockedChallenge.id), eq(challenges.currentClaimId, lockedClaim.id)))
    .returning();

  if (!updatedChallenge) {
    throw new AppError(errorCodes.noActiveClaim);
  }

  const claim = serializeClaim(updatedClaim);
  const challenge = serializeChallenge(updatedChallenge);
  const { stateVersion } = await appendEvents(db, {
    gameId: input.gameId,
    events: [
      {
        eventType: eventTypes.objectiveStateChanged,
        entityType: 'challenge',
        entityId: updatedChallenge.id,
        actorType: 'player',
        actorId: input.playerId,
        actorTeamId: input.teamId,
        beforeState: {
          status: lockedChallenge.status,
          currentClaimId: lockedChallenge.currentClaimId,
          expiresAt: lockedChallenge.expiresAt?.toISOString() ?? null,
          zoneId: lockedChallenge.zoneId,
        },
        afterState: {
          status: updatedChallenge.status,
          currentClaimId: updatedChallenge.currentClaimId,
          expiresAt: updatedChallenge.expiresAt?.toISOString() ?? null,
          zoneId: updatedChallenge.zoneId,
        },
        meta: {
          reason: 'released',
          challenge,
          claim,
        } as unknown as JsonObject,
      },
      {
        eventType: eventTypes.challengeReleased,
        entityType: 'challenge_claim',
        entityId: updatedClaim.id,
        actorType: 'player',
        actorId: input.playerId,
        actorTeamId: input.teamId,
        afterState: claim as unknown as JsonValue,
        meta: {
          reason: 'released',
          challengeId: updatedChallenge.id,
        },
      },
    ],
  });

  return {
    gameId: input.gameId,
    stateVersion,
    challenge,
    claim,
  };
}

async function lockActiveClaim(
  db: DatabaseClient,
  challenge: typeof challenges.$inferSelect,
): Promise<typeof challengeClaims.$inferSelect> {
  if (challenge.status !== 'claimed' || !challenge.currentClaimId) {
    throw new AppError(errorCodes.noActiveClaim);
  }

  const [claim] = await db
    .select()
    .from(challengeClaims)
    .where(eq(challengeClaims.id, challenge.currentClaimId))
    .limit(1)
    .for('update');

  if (!claim || claim.challengeId !== challenge.id || claim.status !== ACTIVE_CLAIM_STATUS) {
    throw new AppError(errorCodes.noActiveClaim);
  }

  return claim;
}
