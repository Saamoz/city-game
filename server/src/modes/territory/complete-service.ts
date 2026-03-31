import { and, eq } from 'drizzle-orm';
import {
  RESOURCE_TYPE_VALUES,
  errorCodes,
  eventTypes,
  type Challenge,
  type ChallengeClaim,
  type JsonObject,
  type JsonValue,
  type ResourceAwardMap,
  type ResourceLedgerEntry,
  type Zone,
} from '@city-game/shared';
import type { DatabaseClient } from '../../db/connection.js';
import { challengeClaims, challenges, zones } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { appendEvents, type AppendEventInput } from '../../services/event-service.js';
import { getGameById } from '../../services/game-service.js';
import { transactInTransaction } from '../../services/resource-service.js';
import { getZoneByIdOrThrow } from '../../services/spatial-service.js';
import { lockChallenge, serializeChallenge, serializeClaim } from './claim-service.js';

const ACTIVE_CLAIM_STATUS = 'active';

export interface CompleteChallengeInput {
  challengeId: string;
  gameId: string;
  playerId: string;
  teamId: string;
  submission?: JsonValue | null;
}

export interface CompleteChallengeSuccessResult {
  kind: 'completed';
  gameId: string;
  stateVersion: number;
  challenge: Challenge;
  claim: ChallengeClaim;
  zone: Zone | null;
  resourcesAwarded: ResourceAwardMap;
  resourceEntries: ResourceLedgerEntry[];
}

export interface CompleteChallengeExpiredResult {
  kind: 'expired';
  gameId: string;
  stateVersion: number;
  challenge: Challenge;
  claim: ChallengeClaim;
}

export type CompleteChallengeResult = CompleteChallengeSuccessResult | CompleteChallengeExpiredResult;

export async function completeChallenge(
  db: DatabaseClient,
  input: CompleteChallengeInput,
): Promise<CompleteChallengeResult> {
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

  if (lockedClaim.expiresAt <= now) {
    const expiredResult = await expireClaim(db, {
      gameId: input.gameId,
      challenge: lockedChallenge,
      claim: lockedClaim,
      now,
    });

    return {
      kind: 'expired',
      ...expiredResult,
    };
  }

  const zoneBefore = lockedChallenge.zoneId ? await lockZone(db, lockedChallenge.zoneId) : null;

  const [updatedClaim] = await db
    .update(challengeClaims)
    .set({
      status: 'completed',
      completedAt: now,
      submission: input.submission ?? null,
    })
    .where(and(eq(challengeClaims.id, lockedClaim.id), eq(challengeClaims.status, ACTIVE_CLAIM_STATUS)))
    .returning();

  if (!updatedClaim) {
    throw new AppError(errorCodes.noActiveClaim);
  }

  const [updatedChallenge] = await db
    .update(challenges)
    .set({
      status: 'completed',
      currentClaimId: null,
      expiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(challenges.id, lockedChallenge.id), eq(challenges.currentClaimId, lockedClaim.id)))
    .returning();

  if (!updatedChallenge) {
    throw new AppError(errorCodes.noActiveClaim);
  }

  let updatedZone: Zone | null = null;
  if (lockedChallenge.zoneId) {
    await db
      .update(zones)
      .set({
        ownerTeamId: input.teamId,
        capturedAt: now,
        updatedAt: now,
      })
      .where(eq(zones.id, lockedChallenge.zoneId));

    updatedZone = await getZoneByIdOrThrow(db, lockedChallenge.zoneId);
  }

  const resourcesAwarded = normalizeResourceAwards(updatedChallenge.scoring as ResourceAwardMap);
  const resourceEntries: ResourceLedgerEntry[] = [];

  for (const resourceType of RESOURCE_TYPE_VALUES) {
    const delta = resourcesAwarded[resourceType] ?? 0;

    if (delta === 0) {
      continue;
    }

    resourceEntries.push(
      await transactInTransaction(db, {
        gameId: input.gameId,
        teamId: input.teamId,
        resourceType,
        delta,
        reason: 'challenge_completed',
        referenceId: updatedChallenge.id,
        referenceType: 'challenge',
      }),
    );
  }

  const claim = serializeClaim(updatedClaim);
  const challenge = serializeChallenge(updatedChallenge);
  const events: AppendEventInput[] = [
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
      },
      afterState: {
        status: updatedChallenge.status,
        currentClaimId: updatedChallenge.currentClaimId,
        expiresAt: updatedChallenge.expiresAt?.toISOString() ?? null,
      },
      meta: {
        challenge,
        claim,
      } as unknown as JsonObject,
    },
  ];

  if (zoneBefore && updatedZone) {
    events.push(
      {
        eventType: eventTypes.controlStateChanged,
        entityType: 'zone',
        entityId: updatedZone.id,
        actorType: 'player',
        actorId: input.playerId,
        actorTeamId: input.teamId,
        beforeState: {
          ownerTeamId: zoneBefore.ownerTeamId,
          capturedAt: zoneBefore.capturedAt,
        },
        afterState: {
          ownerTeamId: updatedZone.ownerTeamId,
          capturedAt: updatedZone.capturedAt,
        },
        meta: {
          zone: updatedZone,
          challenge,
          claim,
        } as unknown as JsonObject,
      },
      {
        eventType: eventTypes.zoneCaptured,
        entityType: 'zone',
        entityId: updatedZone.id,
        actorType: 'player',
        actorId: input.playerId,
        actorTeamId: input.teamId,
        afterState: updatedZone as unknown as JsonValue,
        meta: {
          zone: updatedZone,
          challenge,
          claim,
          resourcesAwarded,
        } as unknown as JsonObject,
      },
    );
  }

  for (const entry of resourceEntries) {
    events.push({
      eventType: eventTypes.resourceChanged,
      entityType: 'resource_ledger',
      entityId: entry.id,
      actorType: 'player',
      actorId: input.playerId,
      actorTeamId: input.teamId,
      afterState: entry as unknown as JsonValue,
      meta: {
        entry,
      } as unknown as JsonObject,
    });
  }

  events.push({
    eventType: eventTypes.challengeCompleted,
    entityType: 'challenge_claim',
    entityId: updatedClaim.id,
    actorType: 'player',
    actorId: input.playerId,
    actorTeamId: input.teamId,
    afterState: claim as unknown as JsonValue,
    meta: {
      challenge,
      claim,
      zone: updatedZone,
      resourcesAwarded,
    } as unknown as JsonObject,
  });

  const { stateVersion } = await appendEvents(db, {
    gameId: input.gameId,
    events,
  });

  return {
    kind: 'completed',
    gameId: input.gameId,
    stateVersion,
    challenge,
    claim,
    zone: updatedZone,
    resourcesAwarded,
    resourceEntries,
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

async function lockZone(db: DatabaseClient, zoneId: string): Promise<Zone> {
  const [lockedZone] = await db.select({ id: zones.id }).from(zones).where(eq(zones.id, zoneId)).limit(1).for('update');

  if (!lockedZone) {
    throw new AppError(errorCodes.validationError, {
      message: 'Zone not found.',
    });
  }

  return getZoneByIdOrThrow(db, zoneId);
}

async function expireClaim(
  db: DatabaseClient,
  input: {
    gameId: string;
    challenge: typeof challenges.$inferSelect;
    claim: typeof challengeClaims.$inferSelect;
    now: Date;
  },
): Promise<{
  gameId: string;
  stateVersion: number;
  challenge: Challenge;
  claim: ChallengeClaim;
}> {
  const [updatedClaim] = await db
    .update(challengeClaims)
    .set({
      status: 'expired',
      releasedAt: input.now,
    })
    .where(and(eq(challengeClaims.id, input.claim.id), eq(challengeClaims.status, ACTIVE_CLAIM_STATUS)))
    .returning();

  if (!updatedClaim) {
    throw new AppError(errorCodes.claimExpired);
  }

  const [updatedChallenge] = await db
    .update(challenges)
    .set({
      status: 'available',
      currentClaimId: null,
      expiresAt: null,
      updatedAt: input.now,
    })
    .where(and(eq(challenges.id, input.challenge.id), eq(challenges.currentClaimId, input.claim.id)))
    .returning();

  if (!updatedChallenge) {
    throw new AppError(errorCodes.claimExpired);
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
        actorType: 'system',
        actorId: null,
        actorTeamId: input.claim.teamId,
        beforeState: {
          status: input.challenge.status,
          currentClaimId: input.challenge.currentClaimId,
          expiresAt: input.challenge.expiresAt?.toISOString() ?? null,
        },
        afterState: {
          status: updatedChallenge.status,
          currentClaimId: updatedChallenge.currentClaimId,
          expiresAt: updatedChallenge.expiresAt?.toISOString() ?? null,
        },
        meta: {
          reason: 'expired',
          challenge,
          claim,
        } as unknown as JsonObject,
      },
      {
        eventType: eventTypes.challengeReleased,
        entityType: 'challenge_claim',
        entityId: updatedClaim.id,
        actorType: 'system',
        actorId: null,
        actorTeamId: input.claim.teamId,
        afterState: claim as unknown as JsonValue,
        meta: {
          reason: 'expired',
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

function normalizeResourceAwards(scoring: ResourceAwardMap): ResourceAwardMap {
  const awards: ResourceAwardMap = {};

  for (const resourceType of RESOURCE_TYPE_VALUES) {
    const value = scoring[resourceType];

    if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
      awards[resourceType] = value;
    }
  }

  return awards;
}
