import { and, count, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_CLAIM_TIMEOUT_MINUTES,
  DEFAULT_GPS_BUFFER_METERS,
  errorCodes,
  eventTypes,
  type Challenge,
  type ChallengeClaim,
  type GameSettings,
  type GpsPayload,
  type JsonObject,
  type JsonValue,
  type Zone,
} from '@city-game/shared';
import type { DatabaseClient } from '../../db/connection.js';
import { env } from '../../db/env.js';
import { challengeClaims, challenges } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { appendEvents } from '../../services/event-service.js';
import { getGameById } from '../../services/game-service.js';
import {
  findContainingZones,
  getDistanceToZoneMeters,
  getZoneByIdOrThrow,
  isPointWithinZoneBuffer,
} from '../../services/spatial-service.js';

const ACTIVE_CLAIM_STATUS = 'active';
const DEFAULT_MAX_CONCURRENT_CLAIMS = 1;

export interface ClaimChallengeInput {
  challengeId: string;
  gameId: string;
  playerId: string;
  teamId: string;
  gpsPayload: GpsPayload;
}

export interface ClaimChallengeResult {
  gameId: string;
  stateVersion: number;
  challenge: Challenge;
  claim: ChallengeClaim;
}

export async function claimChallenge(db: DatabaseClient, input: ClaimChallengeInput): Promise<ClaimChallengeResult> {
  const game = await getGameById(db, input.gameId);

  if (game.status !== 'active') {
    throw new AppError(errorCodes.gameNotActive, {
      details: {
        gameId: game.id,
        status: game.status,
      },
    });
  }

  const lockedChallenge = await lockChallenge(db, input.challengeId);

  if (lockedChallenge.gameId !== input.gameId) {
    throw new AppError(errorCodes.validationError, {
      message: 'Challenge not found for the active player game.',
    });
  }

  assertChallengeAvailable(lockedChallenge.status);

  const zone = await resolveClaimZone(db, {
    gameId: input.gameId,
    challenge: lockedChallenge,
    gpsPayload: input.gpsPayload,
  });

  if (zone.isDisabled) {
    throw new AppError(errorCodes.zoneDisabled, {
      details: {
        zoneId: zone.id,
      },
    });
  }

  const gameSettings = game.settings as GameSettings;
  if (gameSettings.require_gps_accuracy) {
    assertGpsAccuracy(zone.maxGpsErrorMeters, input.gpsPayload.gpsErrorMeters);
  }
  await assertPlayerInsideZone(db, zone.id, input.gpsPayload.lat, input.gpsPayload.lng, zone.claimRadiusMeters);
  await assertClaimCapacity(db, input.gameId, input.teamId, gameSettings);

  const claimExpiresAt = new Date(Date.now() + getClaimTimeoutMinutes(gameSettings) * 60_000);
  const locationAtClaim = sql`ST_SetSRID(ST_MakePoint(${input.gpsPayload.lng}, ${input.gpsPayload.lat}), 4326)`;

  let insertedClaim: typeof challengeClaims.$inferSelect;
  try {
    [insertedClaim] = await db
      .insert(challengeClaims)
      .values({
        challengeId: lockedChallenge.id,
        gameId: input.gameId,
        teamId: input.teamId,
        playerId: input.playerId,
        status: ACTIVE_CLAIM_STATUS,
        expiresAt: claimExpiresAt,
        locationAtClaim,
      })
      .returning();
  } catch (error) {
    if (isActiveClaimConstraintError(error)) {
      throw new AppError(errorCodes.challengeAlreadyClaimed);
    }

    throw error;
  }

  const [updatedChallenge] = await db
    .update(challenges)
    .set({
      zoneId: zone.id,
      status: 'claimed',
      currentClaimId: insertedClaim.id,
      expiresAt: claimExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(challenges.id, lockedChallenge.id))
    .returning();

  const serializedClaim = serializeClaim(insertedClaim);
  const serializedChallenge = serializeChallenge(updatedChallenge);
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
          challenge: serializedChallenge,
          claim: serializedClaim,
        } as unknown as JsonObject,
      },
      {
        eventType: eventTypes.challengeClaimed,
        entityType: 'challenge_claim',
        entityId: insertedClaim.id,
        actorType: 'player',
        actorId: input.playerId,
        actorTeamId: input.teamId,
        afterState: serializedClaim as unknown as JsonValue,
        meta: {
          challengeId: updatedChallenge.id,
          zoneId: updatedChallenge.zoneId,
        },
      },
    ],
  });

  return {
    gameId: input.gameId,
    stateVersion,
    challenge: {
      ...serializedChallenge,
      currentClaimId: insertedClaim.id,
    },
    claim: serializedClaim,
  };
}

export async function lockChallenge(db: DatabaseClient, challengeId: string): Promise<typeof challenges.$inferSelect> {
  const [challenge] = await db.select().from(challenges).where(eq(challenges.id, challengeId)).limit(1).for('update');

  if (!challenge) {
    throw new AppError(errorCodes.validationError, {
      message: 'Challenge not found.',
    });
  }

  return challenge;
}

export function isPortableChallengeConfig(config: unknown): boolean {
  return Boolean(
    config &&
      typeof config === 'object' &&
      !Array.isArray(config) &&
      (config as { portable?: unknown }).portable === true,
  );
}

function assertChallengeAvailable(status: string): void {
  if (status === 'claimed') {
    throw new AppError(errorCodes.challengeAlreadyClaimed);
  }

  if (status !== 'available') {
    throw new AppError(errorCodes.challengeNotAvailable, {
      details: {
        status,
      },
    });
  }
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

async function resolveClaimZone(
  db: DatabaseClient,
  input: { gameId: string; challenge: typeof challenges.$inferSelect; gpsPayload: GpsPayload },
): Promise<Zone> {
  if (input.challenge.zoneId) {
    return getZoneByIdOrThrow(db, input.challenge.zoneId);
  }

  if (!isPortableChallengeConfig(input.challenge.config)) {
    throw new AppError(errorCodes.validationError, {
      message: 'Challenge is not assigned to a zone.',
    });
  }

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

async function assertClaimCapacity(
  db: DatabaseClient,
  gameId: string,
  teamId: string,
  settings: GameSettings,
): Promise<void> {
  const maxConcurrentClaims = getMaxConcurrentClaims(settings);

  const [result] = await db
    .select({ count: count() })
    .from(challengeClaims)
    .where(
      and(
        eq(challengeClaims.gameId, gameId),
        eq(challengeClaims.teamId, teamId),
        eq(challengeClaims.status, ACTIVE_CLAIM_STATUS),
      ),
    );

  const activeClaimCount = Number(result?.count ?? 0);

  if (activeClaimCount < maxConcurrentClaims) {
    return;
  }

  throw new AppError(errorCodes.maxConcurrentClaimsReached, {
    details: {
      teamId,
      activeClaimCount,
      maxConcurrentClaims,
    },
  });
}

function getMaxConcurrentClaims(settings: GameSettings): number {
  const configuredValue = settings.max_concurrent_claims;

  if (!Number.isInteger(configuredValue) || (configuredValue as number) < 1) {
    return DEFAULT_MAX_CONCURRENT_CLAIMS;
  }

  return configuredValue as number;
}

function getClaimTimeoutMinutes(settings: GameSettings): number {
  const configuredValue = settings.claim_timeout_minutes;

  if (Number.isInteger(configuredValue) && (configuredValue as number) > 0) {
    return configuredValue as number;
  }

  return Number.isFinite(env.claimTimeoutMinutes) && env.claimTimeoutMinutes > 0
    ? env.claimTimeoutMinutes
    : DEFAULT_CLAIM_TIMEOUT_MINUTES;
}

function isActiveClaimConstraintError(error: unknown): boolean {
  let current: unknown = error;

  while (current && typeof current === 'object') {
    if (
      'code' in current &&
      'constraint' in current &&
      (current as { code?: string }).code === '23505' &&
      (current as { constraint?: string }).constraint === 'idx_one_active_claim_per_challenge'
    ) {
      return true;
    }

    current = 'cause' in current ? (current as { cause?: unknown }).cause : null;
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('idx_one_active_claim_per_challenge') && message.includes('23505');
}

export function serializeChallenge(row: typeof challenges.$inferSelect): Challenge {
  return {
    id: row.id,
    gameId: row.gameId,
    zoneId: row.zoneId,
    title: row.title,
    description: row.description,
    kind: row.kind as Challenge['kind'],
    config: row.config as Challenge['config'],
    completionMode: row.completionMode,
    scoring: row.scoring as Challenge['scoring'],
    difficulty: row.difficulty as Challenge['difficulty'],
    sortOrder: row.sortOrder,
    isDeckActive: row.isDeckActive,
    status: row.status as Challenge['status'],
    currentClaimId: row.currentClaimId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeClaim(row: typeof challengeClaims.$inferSelect): ChallengeClaim {
  return {
    id: row.id,
    challengeId: row.challengeId,
    gameId: row.gameId,
    teamId: row.teamId,
    playerId: row.playerId,
    status: row.status as ChallengeClaim['status'],
    claimedAt: row.claimedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    submission: row.submission as ChallengeClaim['submission'],
    locationAtClaim: row.locationAtClaim as ChallengeClaim['locationAtClaim'],
    warningSent: row.warningSent,
    createdAt: row.createdAt.toISOString(),
  };
}
