import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { errorCodes, eventTypes, type JsonObject, type JsonValue, type ResourceType } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { challengeClaims, challenges, players, resourceLedger, teams, zones } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { appendEvents, type AppendEventInput } from './event-service.js';
import { getGameById, lockGameById } from './game-service.js';
import { transactInTransaction, type ResourceTransactionInput } from './resource-service.js';
import { getZoneByIdOrThrow } from './spatial-service.js';
import { lockChallenge, serializeChallenge, serializeClaim } from '../modes/territory/claim-service.js';
import { completeChallenge } from '../modes/territory/complete-service.js';
import { releaseChallenge } from '../modes/territory/release-service.js';

export interface ForceCompleteOverrideInput {
  challengeId: string;
  // Challenge Hunt: the team to credit (there is no claim to finish).
  teamId?: string | null;
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
  const [challengeRow] = await db.select({ gameId: challenges.gameId }).from(challenges).where(eq(challenges.id, input.challengeId)).limit(1);
  if (!challengeRow) throw new AppError(errorCodes.validationError, { message: 'Challenge not found.' });
  if ((await getGameById(db, challengeRow.gameId)).modeKey === 'point_challenge') {
    return forceCompleteForTeam(db, { ...input, gameId: challengeRow.gameId });
  }

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

// Challenge Hunt has no claims: completing is one step. The admin names the team, and the challenge is
// completed for it as if one of its players had done it there (points, bonuses, clue fragment), with
// no location check. Used when GPS won't cooperate at the spot.
async function forceCompleteForTeam(db: DatabaseClient, input: ForceCompleteOverrideInput & { gameId: string }): Promise<AdminOverrideMutationResult> {
  if (!input.teamId) throw new AppError(errorCodes.validationError, { message: 'Choose the team that completed this challenge.' });
  const [team] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, input.teamId), eq(teams.gameId, input.gameId))).limit(1);
  if (!team) throw new AppError(errorCodes.teamNotFound);
  // A claim records a player; credit the team member seen most recently.
  const [player] = await db.select({ id: players.id }).from(players)
    .where(and(eq(players.gameId, input.gameId), eq(players.teamId, team.id)))
    .orderBy(sql`${players.lastSeenAt} DESC NULLS LAST`, desc(players.createdAt))
    .limit(1);
  if (!player) throw new AppError(errorCodes.validationError, { message: 'That team has no players yet.' });

  const result = await completeChallenge(db, {
    challengeId: input.challengeId,
    gameId: input.gameId,
    playerId: player.id,
    teamId: team.id,
    submission: input.submission ?? null,
    skipLocationCheck: true,
  });
  if (result.kind !== 'completed') throw new AppError(errorCodes.challengeNotAvailable);

  const { stateVersion } = await appendAdminOverride(db, {
    gameId: result.gameId,
    entityType: 'challenge',
    entityId: result.challenge.id,
    action: 'force_complete',
    notes: input.notes,
    beforeState: null,
    afterState: { challenge: result.challenge, claim: result.claim, teamId: team.id, resourcesAwarded: result.resourcesAwarded } as unknown as JsonValue,
  });

  return {
    gameId: result.gameId,
    stateVersion,
    body: { challenge: result.challenge, claim: result.claim, zone: null, resourcesAwarded: result.resourcesAwarded, stateVersion },
  };
}

// Takes back what a challenge's completions earned: the net of its completion awards and earlier
// reset reversals, per team and resource. Judged points (published after the game) are left alone.
async function revokeChallengeAwards(db: DatabaseClient, gameId: string, challengeId: string): Promise<Array<{ teamId: string; resourceType: string; delta: number }>> {
  const rows = await db
    .select({ teamId: resourceLedger.teamId, resourceType: resourceLedger.resourceType, total: sql<string>`SUM(${resourceLedger.delta})` })
    .from(resourceLedger)
    .where(and(eq(resourceLedger.gameId, gameId), eq(resourceLedger.referenceId, challengeId), inArray(resourceLedger.reason, ['challenge_completed', 'challenge_reset'])))
    .groupBy(resourceLedger.teamId, resourceLedger.resourceType);
  const revoked: Array<{ teamId: string; resourceType: string; delta: number }> = [];
  for (const row of rows) {
    const total = Number(row.total);
    if (!row.teamId || !Number.isFinite(total) || total === 0) continue;
    await transactInTransaction(db, { gameId, teamId: row.teamId, resourceType: row.resourceType, delta: -total, reason: 'challenge_reset', referenceId: challengeId, referenceType: 'challenge', allowNegative: true });
    revoked.push({ teamId: row.teamId, resourceType: row.resourceType, delta: -total });
  }
  return revoked;
}

export async function adminResetChallenge(
  db: DatabaseClient,
  input: ResetChallengeOverrideInput,
): Promise<AdminOverrideMutationResult> {
  const now = new Date();
  const [challengeRow] = await db.select({ gameId: challenges.gameId }).from(challenges).where(eq(challenges.id, input.challengeId)).limit(1);
  if (!challengeRow) throw new AppError(errorCodes.validationError, { message: 'Challenge not found.' });
  // Same lock order as a completion (game, then challenge), so a reset can't cross one mid-flight.
  const game = await lockGameById(db, challengeRow.gameId);
  const lockedChallenge = await lockChallenge(db, input.challengeId);
  const activeClaim = lockedChallenge.currentClaimId ? await getActiveClaimIfPresent(db, lockedChallenge) : null;

  // Challenge Hunt: undo the completion itself. The completing team (or, for a judged challenge, every
  // team that submitted) loses the claim, its points and sight of the clue fragment; the fragment stays
  // with the challenge for whoever completes it next.
  let undoneClaims: Array<typeof challengeClaims.$inferSelect> = [];
  let revokedAwards: Array<{ teamId: string; resourceType: string; delta: number }> = [];
  if (game.modeKey === 'point_challenge') {
    undoneClaims = await db
      .update(challengeClaims)
      .set({ status: 'released', releasedAt: now })
      .where(and(eq(challengeClaims.challengeId, lockedChallenge.id), inArray(challengeClaims.status, ['completed', 'submitted'])))
      .returning();
    revokedAwards = await revokeChallengeAwards(db, lockedChallenge.gameId, lockedChallenge.id);
  }

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
      // A completed card left the deck; reopening it puts it back.
      ...(game.modeKey === 'point_challenge' && lockedChallenge.status === 'completed' ? { isDeckActive: true } : {}),
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
        undoneClaimIds: undoneClaims.map((entry) => entry.id),
        revokedAwards,
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
