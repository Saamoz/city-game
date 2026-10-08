import { and, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_GPS_BUFFER_METERS,
  CHALLENGE_AREA_EDGE_TOLERANCE_METERS,
  DEFAULT_POINT_CHALLENGE_RADIUS_METERS,
  errorCodes,
  eventTypes,
  getBasePoints,
  getChallengeArea,
  getClaimedBonuses,
  isJudgedChallengeConfig,
  sumBonusPoints,
  type Challenge,
  type ChallengeClaim,
  type ChallengeRerollState,
  type GameSettings,
  type GeoJsonPoint,
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
import { lockGameById } from '../../services/game-service.js';
import { transactInTransaction } from '../../services/resource-service.js';
import {
  findContainingZones,
  getDistanceToZoneMeters,
  getZoneByIdOrThrow,
  isPointWithinZoneBuffer,
} from '../../services/spatial-service.js';
import { activateNextQueuedChallenge } from './deck-service.js';
import { advanceChallengeRerollCharge, getChallengeRerollState } from './reroll-service.js';
import { isPortableChallengeConfig, lockChallenge, serializeChallenge, serializeClaim } from './claim-service.js';

const ACTIVE_CLAIM_STATUS = 'active';

export interface CompleteChallengeInput {
  challengeId: string;
  gameId: string;
  playerId: string;
  teamId: string;
  submission?: JsonValue | null;
  gpsPayload?: GpsPayload | null;
  targetZoneId?: string | null;
}

export interface CompleteChallengeSuccessResult {
  kind: 'completed';
  gameId: string;
  stateVersion: number;
  challenge: Challenge;
  claim: ChallengeClaim;
  zone: Zone | null;
  activatedChallenge: Challenge | null;
  resourcesAwarded: ResourceAwardMap;
  rerollState: ChallengeRerollState;
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
  const game = await lockGameById(db, input.gameId);

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

  if (isJudgedChallengeConfig(lockedChallenge.config)) {
    return submitJudgedChallenge(db, {
      challenge: lockedChallenge,
      gameId: input.gameId,
      playerId: input.playerId,
      teamId: input.teamId,
      submission: input.submission ?? null,
      gpsPayload: input.gpsPayload ?? null,
      now,
      settings: game.settings as GameSettings,
    });
  }

  if (lockedChallenge.status === 'available' && getChallengeArea(lockedChallenge.config)) {
    return completeAreaChallengeDirectly(db, {
      challenge: lockedChallenge,
      gameId: input.gameId,
      playerId: input.playerId,
      teamId: input.teamId,
      submission: input.submission ?? null,
      gpsPayload: input.gpsPayload ?? null,
      now,
      settings: game.settings as GameSettings,
    });
  }

  if (
    lockedChallenge.status === 'available' &&
    isPointChallengeConfig(lockedChallenge.config) &&
    input.gpsPayload
  ) {
    return completePointChallengeDirectly(db, {
      challenge: lockedChallenge,
      gameId: input.gameId,
      playerId: input.playerId,
      teamId: input.teamId,
      submission: input.submission ?? null,
      gpsPayload: input.gpsPayload,
      now,
      settings: game.settings as GameSettings,
      captureContainingZone: game.modeKey === 'territory',
    });
  }

  if (
    lockedChallenge.status === 'available' &&
    isPortableChallengeConfig(lockedChallenge.config) &&
    game.modeKey === 'point_challenge'
  ) {
    return completeAnywhereChallengeDirectly(db, {
      challenge: lockedChallenge,
      gameId: input.gameId,
      playerId: input.playerId,
      teamId: input.teamId,
      submission: input.submission ?? null,
      gpsPayload: input.gpsPayload ?? null,
      now,
      settings: game.settings as GameSettings,
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
      targetZoneId: input.targetZoneId ?? null,
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
  assertZoneReclaimAllowed(zoneBefore, game.settings as GameSettings);

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
      isDeckActive: false,
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
    settings: game.settings as GameSettings,
  });
}


async function completePointChallengeDirectly(db: DatabaseClient, input: { challenge: typeof challenges.$inferSelect; gameId: string; playerId: string; teamId: string; submission: JsonValue | null; gpsPayload: GpsPayload; now: Date; settings: GameSettings; captureContainingZone: boolean }): Promise<CompleteChallengeSuccessResult> {
  const point = getPointLocation(input.challenge.config);
  if (!point) throw new AppError(errorCodes.validationError, { message: 'Point challenge has no valid map location.' });
  if (input.settings.require_gps_accuracy) assertGpsAccuracy(null, input.gpsPayload.gpsErrorMeters);
  const radiusMeters = getPointRadius(input.challenge.config);
  const distanceMeters = pointDistance([input.gpsPayload.lng, input.gpsPayload.lat], [point.coordinates[0] as number, point.coordinates[1] as number]);
  if (distanceMeters > radiusMeters) throw new AppError(errorCodes.outsideZone, { message: 'Move closer to this challenge location.', details: { challengeId: input.challenge.id, distanceMeters, radiusMeters } });
  const [containingZone] = input.captureContainingZone ? await findContainingZones(db, { gameId: input.gameId, lat: point.coordinates[1] as number, lng: point.coordinates[0] as number, bufferMeters: 0 }) : [];
  const zoneBefore = containingZone ? await lockZone(db, containingZone.id) : null;
  assertZoneReclaimAllowed(zoneBefore, input.settings);
  const locationAtClaim = sql`ST_SetSRID(ST_MakePoint(${input.gpsPayload.lng}, ${input.gpsPayload.lat}), 4326)`;
  const [updatedClaim] = await db.insert(challengeClaims).values({ challengeId: input.challenge.id, gameId: input.gameId, teamId: input.teamId, playerId: input.playerId, status: 'completed', expiresAt: input.now, completedAt: input.now, submission: input.submission, locationAtClaim }).returning();
  const [updatedChallenge] = await db.update(challenges).set({ zoneId: zoneBefore?.id ?? null, status: 'completed', currentClaimId: null, expiresAt: null, isDeckActive: false, updatedAt: input.now }).where(eq(challenges.id, input.challenge.id)).returning();
  if (!updatedClaim || !updatedChallenge) throw new AppError(errorCodes.validationError, { message: 'Challenge completion failed.' });
  return finishChallengeCompletion(db, { gameId: input.gameId, playerId: input.playerId, teamId: input.teamId, now: input.now, lockedChallenge: input.challenge, updatedChallenge, updatedClaim, zoneBefore, settings: input.settings });
}
// Area challenges complete from anywhere inside their drawn area (with a little slack at the edge).
async function completeAreaChallengeDirectly(db: DatabaseClient, input: { challenge: typeof challenges.$inferSelect; gameId: string; playerId: string; teamId: string; submission: JsonValue | null; gpsPayload: GpsPayload | null; now: Date; settings: GameSettings }): Promise<CompleteChallengeSuccessResult> {
  const gpsPayload = await assertInsideChallengeArea(db, input.challenge, input.gpsPayload, input.settings);
  const locationAtClaim = sql`ST_SetSRID(ST_MakePoint(${gpsPayload.lng}, ${gpsPayload.lat}), 4326)`;
  const [updatedClaim] = await db.insert(challengeClaims).values({ challengeId: input.challenge.id, gameId: input.gameId, teamId: input.teamId, playerId: input.playerId, status: 'completed', expiresAt: input.now, completedAt: input.now, submission: input.submission, locationAtClaim }).returning();
  const [updatedChallenge] = await db.update(challenges).set({ status: 'completed', currentClaimId: null, expiresAt: null, isDeckActive: false, updatedAt: input.now }).where(eq(challenges.id, input.challenge.id)).returning();
  if (!updatedClaim || !updatedChallenge) throw new AppError(errorCodes.validationError, { message: 'Challenge completion failed.' });
  return finishChallengeCompletion(db, { gameId: input.gameId, playerId: input.playerId, teamId: input.teamId, now: input.now, lockedChallenge: input.challenge, updatedChallenge, updatedClaim, zoneBefore: null, settings: input.settings });
}

async function assertInsideChallengeArea(db: DatabaseClient, challenge: typeof challenges.$inferSelect, gpsPayload: GpsPayload | null, settings: GameSettings): Promise<GpsPayload> {
  const area = getChallengeArea(challenge.config);
  if (!area) throw new AppError(errorCodes.validationError, { message: 'Challenge has no valid area.' });
  if (!gpsPayload) throw new AppError(errorCodes.validationError, { message: 'GPS location is required for this challenge.' });
  if (settings.require_gps_accuracy) assertGpsAccuracy(null, gpsPayload.gpsErrorMeters);
  const result = await db.execute<{ distance: number }>(sql`
    SELECT ST_Distance(
      ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(area)}), 4326)::geography,
      ST_SetSRID(ST_MakePoint(${gpsPayload.lng}, ${gpsPayload.lat}), 4326)::geography
    ) AS distance
  `);
  const distanceMeters = Number(result.rows[0]?.distance ?? Infinity);
  if (distanceMeters > CHALLENGE_AREA_EDGE_TOLERANCE_METERS) {
    throw new AppError(errorCodes.outsideZone, { message: 'Head into the challenge area to complete this.', details: { challengeId: challenge.id, distanceMeters: Math.round(distanceMeters) } });
  }
  return gpsPayload;
}

// Judged challenges never complete: each team files one 'submitted' claim, the challenge stays open for
// everyone else, and no points move until judges publish scores (judging-service).
async function submitJudgedChallenge(db: DatabaseClient, input: { challenge: typeof challenges.$inferSelect; gameId: string; playerId: string; teamId: string; submission: JsonValue | null; gpsPayload: GpsPayload | null; now: Date; settings: GameSettings }): Promise<CompleteChallengeSuccessResult> {
  if (input.challenge.status !== 'available') throw new AppError(errorCodes.challengeNotAvailable);
  const [existing] = await db.select({ id: challengeClaims.id }).from(challengeClaims)
    .where(and(eq(challengeClaims.challengeId, input.challenge.id), eq(challengeClaims.teamId, input.teamId), eq(challengeClaims.status, 'submitted'))).limit(1);
  if (existing) throw new AppError(errorCodes.challengeNotAvailable, { message: 'Your team already completed this challenge.', details: { challengeId: input.challenge.id } });

  if (getChallengeArea(input.challenge.config)) await assertInsideChallengeArea(db, input.challenge, input.gpsPayload, input.settings);
  const point = getPointLocation(input.challenge.config);
  if (point) {
    if (!input.gpsPayload) throw new AppError(errorCodes.validationError, { message: 'GPS location is required for this challenge.' });
    if (input.settings.require_gps_accuracy) assertGpsAccuracy(null, input.gpsPayload.gpsErrorMeters);
    const radiusMeters = getPointRadius(input.challenge.config);
    const distanceMeters = pointDistance([input.gpsPayload.lng, input.gpsPayload.lat], [point.coordinates[0] as number, point.coordinates[1] as number]);
    if (distanceMeters > radiusMeters) throw new AppError(errorCodes.outsideZone, { message: 'Move closer to this challenge location.', details: { challengeId: input.challenge.id, distanceMeters, radiusMeters } });
  }

  const locationAtClaim = input.gpsPayload ? sql`ST_SetSRID(ST_MakePoint(${input.gpsPayload.lng}, ${input.gpsPayload.lat}), 4326)` : null;
  const [insertedClaim] = await db.insert(challengeClaims).values({ challengeId: input.challenge.id, gameId: input.gameId, teamId: input.teamId, playerId: input.playerId, status: 'submitted', expiresAt: input.now, completedAt: input.now, submission: input.submission, locationAtClaim }).returning();
  if (!insertedClaim) throw new AppError(errorCodes.validationError, { message: 'Challenge submission failed.' });

  // The note is for judges only; everything broadcast to players omits it.
  const claim = { ...serializeClaim(insertedClaim), submission: null };
  const challenge = serializeChallenge(input.challenge);
  const { stateVersion } = await appendEvents(db, {
    gameId: input.gameId,
    events: [{
      eventType: eventTypes.challengeCompleted,
      entityType: 'challenge_claim',
      entityId: insertedClaim.id,
      actorType: 'player',
      actorId: input.playerId,
      actorTeamId: input.teamId,
      afterState: claim as unknown as JsonValue,
      meta: { challenge, claim, zone: null, resourcesAwarded: {}, judged: true } as unknown as JsonObject,
    }],
  });
  const rerollState = await getChallengeRerollState(db, input.gameId);
  return { kind: 'completed', gameId: input.gameId, stateVersion, challenge, claim, zone: null, activatedChallenge: null, resourcesAwarded: {}, rerollState, resourceEntries: [] };
}

// Point Challenge games have no zones, so "anywhere" cards complete on the team's word and only record where they were.
async function completeAnywhereChallengeDirectly(db: DatabaseClient, input: { challenge: typeof challenges.$inferSelect; gameId: string; playerId: string; teamId: string; submission: JsonValue | null; gpsPayload: GpsPayload | null; now: Date; settings: GameSettings }): Promise<CompleteChallengeSuccessResult> {
  const locationAtClaim = input.gpsPayload ? sql`ST_SetSRID(ST_MakePoint(${input.gpsPayload.lng}, ${input.gpsPayload.lat}), 4326)` : null;
  const [updatedClaim] = await db.insert(challengeClaims).values({ challengeId: input.challenge.id, gameId: input.gameId, teamId: input.teamId, playerId: input.playerId, status: 'completed', expiresAt: input.now, completedAt: input.now, submission: input.submission, locationAtClaim }).returning();
  const [updatedChallenge] = await db.update(challenges).set({ status: 'completed', currentClaimId: null, expiresAt: null, isDeckActive: false, updatedAt: input.now }).where(eq(challenges.id, input.challenge.id)).returning();
  if (!updatedClaim || !updatedChallenge) throw new AppError(errorCodes.validationError, { message: 'Challenge completion failed.' });
  return finishChallengeCompletion(db, { gameId: input.gameId, playerId: input.playerId, teamId: input.teamId, now: input.now, lockedChallenge: input.challenge, updatedChallenge, updatedClaim, zoneBefore: null, settings: input.settings });
}
function isPointChallengeConfig(config: unknown): boolean { return getPointLocation(config) !== null; }
function getPointLocation(config: unknown): GeoJsonPoint | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const p = (config as { source_map_point?: unknown }).source_map_point as GeoJsonPoint | undefined;
  return p?.type === 'Point' && Array.isArray(p.coordinates) && typeof p.coordinates[0] === 'number' && typeof p.coordinates[1] === 'number' ? p : null;
}
function getPointRadius(config: unknown): number {
  const r = config && typeof config === 'object' && !Array.isArray(config) ? (config as { point_radius_meters?: unknown }).point_radius_meters : null;
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : DEFAULT_POINT_CHALLENGE_RADIUS_METERS;
}
function pointDistance(a: [number, number], b: [number, number]): number {
  const rad=(v:number)=>v*Math.PI/180, p1=rad(a[1]), p2=rad(b[1]), dp=p2-p1, dl=rad(b[0]-a[0]);
  const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 12742000*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
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
    targetZoneId: string | null;
    now: Date;
    settings: GameSettings;
  },
): Promise<CompleteChallengeSuccessResult> {
  const zone = await resolvePortableZone(db, {
    gameId: input.gameId,
    challenge: input.challenge,
    gpsPayload: input.gpsPayload,
    targetZoneId: input.targetZoneId,
  });

  if (zone.isDisabled) {
    throw new AppError(errorCodes.zoneDisabled, {
      details: {
        zoneId: zone.id,
      },
    });
  }

  if (!input.targetZoneId) {
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
  }

  const zoneBefore = await lockZone(db, zone.id);
  assertZoneReclaimAllowed(zoneBefore, input.settings);
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
      isDeckActive: false,
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
    settings: input.settings,
  });
}

function assertZoneReclaimAllowed(zone: Zone | null, settings: GameSettings): void {
  if (!zone || settings.allow_reclaim_zones !== false || !zone.ownerTeamId) {
    return;
  }

  throw new AppError(errorCodes.validationError, {
    message: 'This zone has already been claimed.',
    details: {
      zoneId: zone.id,
    },
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
    settings: GameSettings;
  },
): Promise<CompleteChallengeSuccessResult> {
  let updatedZone: Zone | null = null;
  let activatedChallenge: Challenge | null = null;
  let activatedZone: Zone | null = null;

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

  // Pinned and area challenges sit outside the deck, so finishing one must not deal another card.
  const activatedChallengeRow = isPointChallengeConfig(input.updatedChallenge.config) || getChallengeArea(input.updatedChallenge.config) ? null : await activateNextQueuedChallenge(db, input.gameId, input.now);
  if (activatedChallengeRow) {
    activatedChallenge = serializeChallenge(activatedChallengeRow);
    if (activatedChallengeRow.zoneId) {
      activatedZone = await getZoneByIdOrThrow(db, activatedChallengeRow.zoneId);
    }
  }

  const rerollState = await advanceChallengeRerollCharge(db, {
    gameId: input.gameId,
    completedChallengeId: input.updatedChallenge.id,
    settings: input.settings,
  });

  const resourcesAwarded = normalizeResourceAwards(input.updatedChallenge.scoring as ResourceAwardMap);
  // Base points (default 1 when unset) plus the self-reported bonus tasks. Judged bonuses are
  // awarded after the game, so a ticked one is ignored here.
  const totalPoints = getBasePoints(input.updatedChallenge.scoring) + sumBonusPoints(getClaimedBonuses(input.updatedChallenge.config, input.updatedClaim.submission).filter((bonus) => !bonus.judged));
  if (totalPoints !== 0) resourcesAwarded.points = totalPoints;
  else delete resourcesAwarded.points;
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
      rerollState,
    } as unknown as JsonObject,
  });

  if (activatedChallenge) {
    events.push({
      eventType: eventTypes.challengeSpawned,
      entityType: 'challenge',
      entityId: activatedChallenge.id,
      actorType: 'system',
      actorId: null,
      actorTeamId: null,
      afterState: activatedChallenge as unknown as JsonValue,
      meta: {
        challenge: activatedChallenge,
        zone: activatedZone,
      } as unknown as JsonObject,
    });
  }

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
    activatedChallenge,
    resourcesAwarded,
    rerollState,
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
    targetZoneId: string | null;
  },
): Promise<Zone> {
  if (input.targetZoneId) {
    const zone = await getZoneByIdOrThrow(db, input.targetZoneId);
    if (zone.gameId !== input.gameId) {
      throw new AppError(errorCodes.validationError, {
        message: 'Zone not found for the active player game.',
      });
    }
    return zone;
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
