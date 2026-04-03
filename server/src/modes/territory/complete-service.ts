import { and, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_GPS_BUFFER_METERS,
  errorCodes,
  eventTypes,
  type Challenge,
  type ChallengeClaim,
  type GameSettings,
  type GpsPayload,
  type JsonObject,
  type JsonValue,
  type ResourceAwardMap,
  type ResourceLedgerEntry,
  type Zone,
} from '@city-game/shared';
import type { DatabaseClient } from '../../db/connection.js';
import { env } from '../../db/env.js';
import { challengeClaims, challenges, zones } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { appendEvents, type AppendEventInput } from '../../services/event-service.js';
import { getGameById } from '../../services/game-service.js';
import { transactInTransaction } from '../../services/resource-service.js';
import {
  findContainingZones,
  getDistanceToZoneMeters,
  getZoneByIdOrThrow,
  isPointWithinZoneBuffer,
} from '../../services/spatial-service.js';
import { isPortableChallengeConfig, lockChallenge, serializeChallenge, serializeClaim } from './claim-service.js';

const ACTIVE_CLAIM_STATUS = 'active';

export interface CompleteChallengeInput {
  challengeId: string;
  gameId: string;
  playerId: string;
  teamId: string;
  submission?: JsonValue | null;
  gpsPayload?: GpsPayload | null;
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

  if (
    lockedChallenge.status === 'available' &&
    isPortableChallengeConfig(lockedChallenge.config) &&
    input.gpsPayload
  ) {
    return completePortableChallengeDirectly(db, {
      challenge: lockedChallenge,
      gameId: input.gameId,
      playerId: input.playerId,
      teamId: input.teamId,
      submission: input.submission ?? null,
      gpsPayload: input.gpsPayload,
      now,
      settings: game.settings as GameSettings,
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

  return finishChallengeCompletion(db, {
    gameId: input.gameId,
    playerId: input.playerId,
    teamId: input.teamId,
    now,
    lockedChallenge,
    updatedChallenge,
    updatedClaim,
    zoneBefore,
  });
}

async function completePortableChallengeDirectly(
  db: DatabaseClient,
  input: {
    challenge: typeof challenges.$inferSelect;
    gameId: string;
    playerId: string;
    teamId: string;
    submission: JsonValue | null;
    gpsPayload: GpsPayload;
    now: Date;
    settings: GameSettings;
  },
): Promise<CompleteChallengeSuccessResult> {
  const zone = await resolvePortableZone(db, {
    gameId: input.gameId,
    challenge: input.challenge,
    gpsPayload: input.gpsPayload,
  });

  if (zone.isDisabled) {
    throw new AppError(errorCodes.zoneDisabled, {
      details: {
        zoneId: zone.id,
      },
    });
  }

  if (input.settings.require_gps_accuracy) {
    assertGpsAccuracy(zone.maxGpsErrorMeters, input.gpsPayload.gpsErrorMeters);
  }

  await assertPlayerInsideZone(
    db,
    zone.id,
    input.gpsPayload.lat,
    input.gpsPayload.lng,
    zone.claimRadiusMeters,
  );

  const zoneBefore = await lockZone(db, zone.id);
  const locationAtClaim = sql`ST_SetSRID(ST_MakePoint(${input.gpsPayload.lng}, ${input.gpsPayload.lat}), 4326)`;

  const [insertedClaim] = await db
    .insert(challengeClaims)
    .values({
      challengeId: input.challenge.id,
      gameId: input.gameId,
      teamId: input.teamId,
      playerId: input.playerId,
      status: 'completed',
      expiresAt: input.now,
      completedAt: input.now,
      submission: input.submission,
      locationAtClaim,
    })
    .returning();

  if (!insertedClaim) {
    throw new AppError(errorCodes.validationError, {
      message: 'Challenge completion failed.',
    });
  }

  const [updatedChallenge] = await db
    .update(challenges)
    .set({
      zoneId: zone.id,
      status: 'completed',
      currentClaimId: null,
      expiresAt: null,
      updatedAt: input.now,
    })
    .where(eq(challenges.id, input.challenge.id))
    .returning();

  if (!updatedChallenge) {
    throw new AppError(errorCodes.validationError, {
      message: 'Challenge completion failed.',
    });
  }

  return finishChallengeCompletion(db, {
    gameId: input.gameId,
    playerId: input.playerId,
    teamId: input.teamId,
    now: input.now,
    lockedChallenge: input.challenge,
    updatedChallenge,
    updatedClaim: insertedClaim,
    zoneBefore,
  });
}

async function finishChallengeCompletion(
  db: DatabaseClient,
  input: {
    gameId: string;
    playerId: string;
    teamId: string;
    now: Date;
    lockedChallenge: typeof challenges.$inferSelect;
    updatedChallenge: typeof challenges.$inferSelect;
    updatedClaim: typeof challengeClaims.$inferSelect;
    zoneBefore: Zone | null;
  },
): Promise<CompleteChallengeSuccessResult> {
  let updatedZone: Zone | null = null;
  if (input.updatedChallenge.zoneId) {
    await db
      .update(zones)
      .set({
        ownerTeamId: input.teamId,
        capturedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(zones.id, input.updatedChallenge.zoneId));

    updatedZone = await getZoneByIdOrThrow(db, input.updatedChallenge.zoneId);
  }

  const resourcesAwarded = normalizeResourceAwards(input.updatedChallenge.scoring as ResourceAwardMap);
  const resourceEntries: ResourceLedgerEntry[] = [];

  for (const [resourceType, delta] of Object.entries(resourcesAwarded)) {
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) {
      continue;
    }

    resourceEntries.push(
      await transactInTransaction(db, {
        gameId: input.gameId,
        teamId: input.teamId,
        resourceType,
        delta,
        reason: 'challenge_completed',
        referenceId: input.updatedChallenge.id,
        referenceType: 'challenge',
      }),
    );
  }

  const claim = serializeClaim(input.updatedClaim);
  const challenge = serializeChallenge(input.updatedChallenge);
  const events: AppendEventInput[] = [
    {
      eventType: eventTypes.objectiveStateChanged,
      entityType: 'challenge',
      entityId: input.updatedChallenge.id,
      actorType: 'player',
      actorId: input.playerId,
      actorTeamId: input.teamId,
      beforeState: {
        status: input.lockedChallenge.status,
        currentClaimId: input.lockedChallenge.currentClaimId,
        expiresAt: input.lockedChallenge.expiresAt?.toISOString() ?? null,
        zoneId: input.lockedChallenge.zoneId,
      },
      afterState: {
        status: input.updatedChallenge.status,
        currentClaimId: input.updatedChallenge.currentClaimId,
        expiresAt: input.updatedChallenge.expiresAt?.toISOString() ?? null,
        zoneId: input.updatedChallenge.zoneId,
      },
      meta: {
        challenge,
        claim,
      } as unknown as JsonObject,
    },
  ];

  if (input.zoneBefore && updatedZone) {
    events.push(
      {
        eventType: eventTypes.controlStateChanged,
        entityType: 'zone',
        entityId: updatedZone.id,
        actorType: 'player',
        actorId: input.playerId,
        actorTeamId: input.teamId,
        beforeState: {
          ownerTeamId: input.zoneBefore.ownerTeamId,
          capturedAt: input.zoneBefore.capturedAt,
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
    entityId: input.updatedClaim.id,
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

async function resolvePortableZone(
  db: DatabaseClient,
  input: {
    gameId: string;
    challenge: typeof challenges.$inferSelect;
    gpsPayload: GpsPayload;
  },
): Promise<Zone> {
  const [zone] = await findContainingZones(db, {
    gameId: input.gameId,
    lat: input.gpsPayload.lat,
    lng: input.gpsPayload.lng,
  });

  if (!zone) {
    throw new AppError(errorCodes.outsideZone, {
      message: 'Move into a zone before claiming this card.',
      details: {
        lat: input.gpsPayload.lat,
        lng: input.gpsPayload.lng,
      },
    });
  }

  return zone;
}

function assertGpsAccuracy(zoneMaxErrorMeters: number | null, gpsErrorMeters: number): void {
  if (gpsErrorMeters > env.gpsMaxErrorMeters) {
    throw new AppError(errorCodes.gpsErrorTooHigh, {
      details: {
        maxErrorMeters: env.gpsMaxErrorMeters,
        gpsErrorMeters,
      },
    });
  }

  if (zoneMaxErrorMeters !== null && gpsErrorMeters > zoneMaxErrorMeters) {
    throw new AppError(errorCodes.gpsErrorTooHigh, {
      details: {
        maxErrorMeters: zoneMaxErrorMeters,
        gpsErrorMeters,
      },
    });
  }
}

async function assertPlayerInsideZone(
  db: DatabaseClient,
  zoneId: string,
  lat: number,
  lng: number,
  claimRadiusMeters: number | null,
): Promise<void> {
  const covered = await isPointWithinZoneBuffer(db, {
    zoneId,
    lat,
    lng,
    bufferMeters: claimRadiusMeters ?? undefined,
  });

  if (covered) {
    return;
  }

  const distanceMeters = await getDistanceToZoneMeters(db, { zoneId, lat, lng });
  throw new AppError(errorCodes.outsideZone, {
    details: {
      zoneId,
      distanceMeters,
      bufferMeters: claimRadiusMeters ?? DEFAULT_GPS_BUFFER_METERS,
    },
  });
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
      zoneId: isPortableChallengeConfig(input.challenge.config) ? null : input.challenge.zoneId,
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
          zoneId: input.challenge.zoneId,
        },
        afterState: {
          status: updatedChallenge.status,
          currentClaimId: updatedChallenge.currentClaimId,
          expiresAt: updatedChallenge.expiresAt?.toISOString() ?? null,
          zoneId: updatedChallenge.zoneId,
        },
        meta: {
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
          challengeId: updatedChallenge.id,
          claim,
        } as unknown as JsonObject,
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
  return Object.entries(scoring).reduce<ResourceAwardMap>((awards, [resourceType, value]) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return awards;
    }

    awards[resourceType] = value;
    return awards;
  }, {});
}
