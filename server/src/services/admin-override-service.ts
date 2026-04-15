import { and, eq } from 'drizzle-orm';
import { errorCodes, eventTypes, type JsonObject, type JsonValue, type ResourceType } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { challengeClaims, challenges, players, teams, zones } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { appendEvents, type AppendEventInput } from './event-service.js';
import { getGameById } from './game-service.js';
import { transactInTransaction, type ResourceTransactionInput } from './resource-service.js';
import { getZoneByIdOrThrow } from './spatial-service.js';
import { lockChallenge, serializeChallenge, serializeClaim } from '../modes/territory/claim-service.js';
import { completeChallenge } from '../modes/territory/complete-service.js';
import { releaseChallenge } from '../modes/territory/release-service.js';

export interface ForceCompleteOverrideInput {
  challengeId: string;
  submission?: JsonValue | null;
  notes?: string;
}

export interface ResetChallengeOverrideInput {
  challengeId: string;
  notes?: string;
}

export interface AssignZoneOwnerOverrideInput {
  zoneId: string;
  teamId: string | null;
  notes?: string;
}

export interface MovePlayerTeamOverrideInput {
  playerId: string;
  teamId: string | null;
  notes?: string;
}

export interface RebroadcastStateOverrideInput {
  gameId: string;
  notes?: string;
}

export interface AdjustResourcesOverrideInput {
  gameId: string;
  teamId: string;
  resourceType: ResourceType;
  delta: number;
  reason?: string;
  notes?: string;
  allowNegative?: boolean;
}

export interface AdminOverrideMutationResult {
  gameId: string;
  stateVersion: number;
  body: unknown;
  playerId?: string;
}

export async function adminForceCompleteChallenge(
  db: DatabaseClient,
  input: ForceCompleteOverrideInput,
): Promise<AdminOverrideMutationResult> {
  const lockedChallenge = await lockChallenge(db, input.challengeId);
  const activeClaim = await getActiveClaimForChallenge(db, lockedChallenge);

  const result = await completeChallenge(db, {
    challengeId: lockedChallenge.id,
    gameId: lockedChallenge.gameId,
    playerId: activeClaim.playerId,
    teamId: activeClaim.teamId,
    submission: input.submission ?? null,
  });

  if (result.kind !== 'completed') {
    throw new AppError(errorCodes.claimExpired);
  }

  const { stateVersion } = await appendAdminOverride(db, {
    gameId: result.gameId,
    entityType: 'challenge',
    entityId: result.challenge.id,
    action: 'force_complete',
    notes: input.notes,
    beforeState: null,
    afterState: {
      challenge: result.challenge,
      claim: result.claim,
      zone: result.zone,
      resourcesAwarded: result.resourcesAwarded,
    } as unknown as JsonValue,
  });

  return {
    gameId: result.gameId,
    stateVersion,
    body: {
      challenge: result.challenge,
      claim: result.claim,
      zone: result.zone,
      resourcesAwarded: result.resourcesAwarded,
      stateVersion,
    },
  };
}

export async function adminResetChallenge(
  db: DatabaseClient,
  input: ResetChallengeOverrideInput,
): Promise<AdminOverrideMutationResult> {
  const now = new Date();
  const lockedChallenge = await lockChallenge(db, input.challengeId);
  const activeClaim = lockedChallenge.currentClaimId ? await getActiveClaimIfPresent(db, lockedChallenge) : null;

  let releasedClaim = null;
  if (activeClaim) {
    [releasedClaim] = await db
      .update(challengeClaims)
      .set({
        status: 'released',
        releasedAt: now,
      })
      .where(and(eq(challengeClaims.id, activeClaim.id), eq(challengeClaims.status, 'active')))
      .returning();
  }

  const [updatedChallenge] = await db
    .update(challenges)
    .set({
      status: 'available',
      currentClaimId: null,
      expiresAt: null,
      updatedAt: now,
    })
    .where(eq(challenges.id, lockedChallenge.id))
    .returning();

  const challenge = serializeChallenge(updatedChallenge);
  const claim = releasedClaim ? serializeClaim(releasedClaim) : null;
  const events: AppendEventInput[] = [
    {
      eventType: eventTypes.objectiveStateChanged,
      entityType: 'challenge',
      entityId: updatedChallenge.id,
      actorType: 'admin',
      actorId: null,
      actorTeamId: activeClaim?.teamId ?? null,
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
        reason: 'admin_reset',
        challenge,
        claim,
      } as unknown as JsonObject,
    },
  ];

  if (claim) {
    events.push({
      eventType: eventTypes.challengeReleased,
      entityType: 'challenge_claim',
      entityId: claim.id,
      actorType: 'admin',
      actorId: null,
      actorTeamId: claim.teamId,
      afterState: claim as unknown as JsonValue,
      meta: {
        reason: 'admin_reset',
        challengeId: updatedChallenge.id,
      },
    });
  }

  const { stateVersion } = await appendEvents(db, {
    gameId: lockedChallenge.gameId,
    events: [
      ...events,
      buildAdminOverrideEvent({
        entityType: 'challenge',
        entityId: updatedChallenge.id,
        action: 'reset',
        notes: input.notes,
        afterState: {
          challenge,
          claim,
        } as unknown as JsonValue,
      }),
    ],
  });

  return {
    gameId: lockedChallenge.gameId,
    stateVersion,
    body: {
      challenge,
      claim,
      stateVersion,
    },
  };
}

export async function adminAssignZoneOwner(
  db: DatabaseClient,
  input: AssignZoneOwnerOverrideInput,
): Promise<AdminOverrideMutationResult> {
  const now = new Date();
  const zone = await getZoneByIdOrThrow(db, input.zoneId);

  if (input.teamId) {
    await assertTeamInGame(db, zone.gameId, input.teamId);
  }

  const [updatedZone] = await db
    .update(zones)
    .set({
      ownerTeamId: input.teamId,
      capturedAt: input.teamId ? now : null,
      updatedAt: now,
    })
    .where(eq(zones.id, zone.id))
    .returning({ id: zones.id });

  if (!updatedZone) {
    throw new AppError(errorCodes.validationError, {
      message: 'Zone not found.',
    });
  }

  const nextZone = await getZoneByIdOrThrow(db, zone.id);
  const { stateVersion } = await appendEvents(db, {
    gameId: zone.gameId,
    events: [
      {
        eventType: eventTypes.controlStateChanged,
        entityType: 'zone',
        entityId: zone.id,
        actorType: 'admin',
        actorId: null,
        actorTeamId: input.teamId,
        beforeState: {
          ownerTeamId: zone.ownerTeamId,
          capturedAt: zone.capturedAt,
        },
        afterState: {
          ownerTeamId: nextZone.ownerTeamId,
          capturedAt: nextZone.capturedAt,
        },
        meta: {
          zone: nextZone,
        } as unknown as JsonObject,
      },
      buildAdminOverrideEvent({
        entityType: 'zone',
        entityId: zone.id,
        action: 'assign_owner',
        notes: input.notes,
        beforeState: zone as unknown as JsonValue,
        afterState: nextZone as unknown as JsonValue,
      }),
    ],
  });

  return {
    gameId: zone.gameId,
    stateVersion,
    body: {
      zone: nextZone,
      stateVersion,
    },
  };
}

export async function adminMovePlayerTeam(
  db: DatabaseClient,
  input: MovePlayerTeamOverrideInput,
): Promise<AdminOverrideMutationResult> {
  const [player] = await db.select().from(players).where(eq(players.id, input.playerId)).limit(1).for('update');

  if (!player) {
    throw new AppError(errorCodes.unauthorized, {
      message: 'Player not found.',
    });
  }

  if (input.teamId) {
    await assertTeamInGame(db, player.gameId, input.teamId);
  }

  const [updatedPlayer] = await db
    .update(players)
    .set({
      teamId: input.teamId,
      metadata: {
        ...(player.metadata as JsonObject),
        lobby_ready: false,
      },
    })
    .where(eq(players.id, player.id))
    .returning();

  const { stateVersion } = await appendEvents(db, {
    gameId: player.gameId,
    events: [
      buildAdminOverrideEvent({
        entityType: 'player',
        entityId: player.id,
        action: 'move_team',
        notes: input.notes,
        beforeState: { teamId: player.teamId },
        afterState: { teamId: updatedPlayer.teamId },
      }),
    ],
  });

  return {
    gameId: player.gameId,
    playerId: player.id,
    stateVersion,
    body: {
      player: serializePlayerRow(updatedPlayer),
      stateVersion,
    },
  };
}

export async function adminRebroadcastState(
  db: DatabaseClient,
  input: RebroadcastStateOverrideInput,
): Promise<AdminOverrideMutationResult> {
  await getGameById(db, input.gameId);

  const { stateVersion } = await appendAdminOverride(db, {
    gameId: input.gameId,
    entityType: 'game',
    entityId: input.gameId,
    action: 'rebroadcast_state',
    notes: input.notes,
  });

  return {
    gameId: input.gameId,
    stateVersion,
    body: {
      gameId: input.gameId,
      stateVersion,
    },
  };
}

export async function adminAdjustResources(
  db: DatabaseClient,
  input: AdjustResourcesOverrideInput,
): Promise<AdminOverrideMutationResult> {
  await getGameById(db, input.gameId);
  await assertTeamInGame(db, input.gameId, input.teamId);

  const entry = await transactInTransaction(db, {
    gameId: input.gameId,
    teamId: input.teamId,
    resourceType: input.resourceType,
    delta: input.delta,
    reason: input.reason ?? 'admin_adjustment',
    referenceType: 'admin_override',
    allowNegative: input.allowNegative ?? true,
  } satisfies ResourceTransactionInput);

  const { stateVersion } = await appendEvents(db, {
    gameId: input.gameId,
    events: [
      {
        eventType: eventTypes.resourceChanged,
        entityType: 'resource_ledger',
        entityId: entry.id,
        actorType: 'admin',
        actorId: null,
        actorTeamId: input.teamId,
        afterState: entry as unknown as JsonValue,
        meta: {
          entry,
        } as unknown as JsonObject,
      },
      buildAdminOverrideEvent({
        entityType: 'resource_ledger',
        entityId: entry.id,
        action: 'adjust_resources',
        notes: input.notes,
        afterState: entry as unknown as JsonValue,
      }),
    ],
  });

  return {
    gameId: input.gameId,
    stateVersion,
    body: {
      entry,
      stateVersion,
    },
  };
}

async function appendAdminOverride(
  db: DatabaseClient,
  input: {
    gameId: string;
    entityType: 'game' | 'team' | 'player' | 'zone' | 'challenge' | 'challenge_claim' | 'resource_ledger' | 'annotation';
    entityId: string;
    action: string;
    notes?: string;
    beforeState?: JsonValue | null;
    afterState?: JsonValue | null;
  },
) {
  return appendEvents(db, {
    gameId: input.gameId,
    events: [
      buildAdminOverrideEvent({
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        notes: input.notes,
        beforeState: input.beforeState,
        afterState: input.afterState,
      }),
    ],
  });
}

function buildAdminOverrideEvent(input: {
  entityType: 'game' | 'team' | 'player' | 'zone' | 'challenge' | 'challenge_claim' | 'resource_ledger' | 'annotation';
  entityId: string;
  action: string;
  notes?: string;
  beforeState?: JsonValue | null;
  afterState?: JsonValue | null;
}): AppendEventInput<typeof eventTypes.adminOverride> {
  return {
    eventType: eventTypes.adminOverride,
    entityType: input.entityType,
    entityId: input.entityId,
    actorType: 'admin',
    actorId: null,
    actorTeamId: null,
    beforeState: input.beforeState ?? null,
    afterState: input.afterState ?? null,
    meta: {
      action: input.action,
      ...(input.notes ? { notes: input.notes } : {}),
    },
  };
}

async function getActiveClaimForChallenge(db: DatabaseClient, challenge: typeof challenges.$inferSelect) {
  const claim = await getActiveClaimIfPresent(db, challenge);

  if (!claim) {
    throw new AppError(errorCodes.noActiveClaim);
  }

  return claim;
}

async function getActiveClaimIfPresent(db: DatabaseClient, challenge: typeof challenges.$inferSelect) {
  if (!challenge.currentClaimId) {
    return null;
  }

  const [claim] = await db
    .select()
    .from(challengeClaims)
    .where(eq(challengeClaims.id, challenge.currentClaimId))
    .limit(1)
    .for('update');

  if (!claim || claim.challengeId !== challenge.id || claim.status !== 'active') {
    return null;
  }

  return claim;
}

async function assertTeamInGame(db: DatabaseClient, gameId: string, teamId: string) {
  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.gameId, gameId)))
    .limit(1);

  if (!team) {
    throw new AppError(errorCodes.teamNotFound);
  }
}

function serializePlayerRow(row: typeof players.$inferSelect) {
  return {
    id: row.id,
    gameId: row.gameId,
    teamId: row.teamId,
    displayName: row.displayName,
    pushSubscription: row.pushSubscription,
    lastLat: row.lastLat === null ? null : Number(row.lastLat),
    lastLng: row.lastLng === null ? null : Number(row.lastLng),
    lastGpsError: row.lastGpsError,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}
