import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  eventTypes,
  socketServerEventTypes,
  type Challenge,
  type ChallengeClaim,
  type JsonObject,
  type JsonValue,
} from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { challengeClaims, challenges } from '../db/schema.js';
import type { ModeRegistry } from '../modes/index.js';
import { isPortableChallengeConfig, serializeChallenge, serializeClaim } from '../modes/territory/claim-service.js';
import { appendEvents } from '../services/event-service.js';
import type { NotificationService } from '../services/notification-service.js';
import type { Broadcaster } from '../socket/broadcaster.js';

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_WARNING_WINDOW_MS = 2 * 60_000;
const WARNING_MESSAGE = 'Your claim is about to expire!';
const WARNING_TITLE = 'Claim expiring soon';

interface ExpiredClaimRow extends Record<string, unknown> {
  claimId: string;
  challengeId: string;
  gameId: string;
  modeKey: string;
  teamId: string;
  playerId: string;
  claimedAt: Date | string;
  expiresAt: Date | string;
  submission: JsonValue | null;
  locationAtClaim: ChallengeClaim['locationAtClaim'];
  warningSent: boolean;
  createdAt: Date;
  challengeTitle: string;
  challengeDescription: string;
  challengeKind: Challenge['kind'];
  challengeConfig: Challenge['config'];
  challengeCompletionMode: string;
  challengeScoring: Challenge['scoring'];
  challengeDifficulty: Challenge['difficulty'];
  challengeStatus: Challenge['status'];
  challengeCurrentClaimId: string | null;
  challengeExpiresAt: Date | string | null;
  challengeCreatedAt: Date | string;
  challengeUpdatedAt: Date | string;
  zoneId: string | null;
}

interface WarningClaimRow extends Record<string, unknown> {
  claimId: string;
  challengeId: string;
  gameId: string;
  teamId: string;
  expiresAt: Date | string;
}

export interface ClaimTimeoutSweepInput {
  db: DatabaseClient;
  broadcaster: Pick<Broadcaster, 'send'>;
  modeRegistry: ModeRegistry;
  notificationService: NotificationService;
  now?: Date;
  batchSize?: number;
  warningWindowMs?: number;
}

export interface ClaimTimeoutSweepResult {
  expiredClaims: number;
  warningNotifications: number;
}

export interface ClaimTimeoutJobOptions {
  intervalMs?: number;
  warningWindowMs?: number;
  now?: () => Date;
}

export interface ClaimTimeoutJobController {
  stop(): void;
  runNow(): Promise<ClaimTimeoutSweepResult>;
}

export async function runClaimTimeoutSweep(input: ClaimTimeoutSweepInput): Promise<ClaimTimeoutSweepResult> {
  const now = input.now ?? new Date();
  const batchSize = input.batchSize ?? 100;
  const warningWindowMs = input.warningWindowMs ?? DEFAULT_WARNING_WINDOW_MS;

  let expiredClaims = 0;
  let warningNotifications = 0;

  while (true) {
    const expiredBatch = await expireClaimsBatch({
      ...input,
      now,
      batchSize,
    });

    expiredClaims += expiredBatch.length;

    for (const item of expiredBatch) {
      await input.broadcaster.send({
        gameId: item.gameId,
        modeKey: item.modeKey,
        eventType: socketServerEventTypes.challengeReleased,
        stateVersion: item.stateVersion,
        payload: {
          challenge: item.challenge,
          claim: item.claim,
        },
      });
    }

    if (expiredBatch.length < batchSize) {
      break;
    }
  }

  while (true) {
    const warningBatch = await warnClaimsBatch({
      ...input,
      now,
      batchSize,
      warningWindowMs,
    });

    warningNotifications += warningBatch.length;

    for (const item of warningBatch) {
      await input.notificationService.sendTeamNotification({
        gameId: item.gameId,
        teamId: item.teamId,
        title: WARNING_TITLE,
        body: WARNING_MESSAGE,
        priority: 'high',
        meta: {
          claimId: item.claimId,
          challengeId: item.challengeId,
          expiresAt: toIsoTimestamp(item.expiresAt),
        },
      });
    }

    if (warningBatch.length < batchSize) {
      break;
    }
  }

  return {
    expiredClaims,
    warningNotifications,
  };
}

export function startClaimTimeoutJob(
  app: FastifyInstance,
  options: ClaimTimeoutJobOptions = {},
): ClaimTimeoutJobController {
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const warningWindowMs = options.warningWindowMs ?? DEFAULT_WARNING_WINDOW_MS;
  let closed = false;
  let inFlight: Promise<ClaimTimeoutSweepResult> | null = null;

  const runNow = async () => {
    if (closed) {
      return { expiredClaims: 0, warningNotifications: 0 };
    }

    if (inFlight) {
      return inFlight;
    }

    inFlight = runClaimTimeoutSweep({
      db: app.db,
      broadcaster: app.broadcaster,
      modeRegistry: app.modeRegistry,
      notificationService: app.notificationService,
      warningWindowMs,
      now: options.now?.(),
    }).finally(() => {
      inFlight = null;
    });

    return inFlight;
  };

  const timer = setInterval(() => {
    void runNow();
  }, intervalMs);
  timer.unref?.();

  void runNow();

  const stop = () => {
    if (closed) {
      return;
    }

    closed = true;
    clearInterval(timer);
  };

  app.addHook('onClose', async () => {
    stop();
  });

  return {
    stop,
    runNow,
  };
}

async function expireClaimsBatch(
  input: Required<Pick<ClaimTimeoutSweepInput, 'db' | 'now'>> &
    Pick<ClaimTimeoutSweepInput, 'modeRegistry'> & { batchSize: number },
): Promise<Array<{ gameId: string; modeKey: string; stateVersion: number; challenge: Challenge; claim: ChallengeClaim }>> {
  return input.db.transaction(async (tx) => {
    const db = tx as unknown as DatabaseClient;
    const lockedClaims = await db.execute<ExpiredClaimRow>(sql`
      SELECT
        claim.id AS "claimId",
        claim.challenge_id AS "challengeId",
        claim.game_id AS "gameId",
        game.mode_key AS "modeKey",
        claim.team_id AS "teamId",
        claim.player_id AS "playerId",
        claim.claimed_at AS "claimedAt",
        claim.expires_at AS "expiresAt",
        claim.submission AS "submission",
        ST_AsGeoJSON(claim.location_at_claim)::json AS "locationAtClaim",
        claim.warning_sent AS "warningSent",
        claim.created_at AS "createdAt",
        challenge.zone_id AS "zoneId",
        challenge.title AS "challengeTitle",
        challenge.description AS "challengeDescription",
        challenge.kind AS "challengeKind",
        challenge.config AS "challengeConfig",
        challenge.completion_mode AS "challengeCompletionMode",
        challenge.scoring AS "challengeScoring",
        challenge.difficulty AS "challengeDifficulty",
        challenge.status AS "challengeStatus",
        challenge.current_claim_id AS "challengeCurrentClaimId",
        challenge.expires_at AS "challengeExpiresAt",
        challenge.created_at AS "challengeCreatedAt",
        challenge.updated_at AS "challengeUpdatedAt"
      FROM challenge_claims AS claim
      INNER JOIN challenges AS challenge
        ON challenge.current_claim_id = claim.id
      INNER JOIN games AS game
        ON game.id = claim.game_id
      WHERE claim.status = 'active'
        AND claim.expires_at <= ${input.now}
        AND challenge.status = 'claimed'
      ORDER BY claim.expires_at ASC
      FOR UPDATE OF claim, challenge SKIP LOCKED
      LIMIT ${input.batchSize}
    `);

    const expired: Array<{ gameId: string; modeKey: string; stateVersion: number; challenge: Challenge; claim: ChallengeClaim }> = [];

    for (const row of lockedClaims.rows) {
      const [updatedClaim] = await db
        .update(challengeClaims)
        .set({
          status: 'expired',
          releasedAt: input.now,
        })
        .where(and(eq(challengeClaims.id, row.claimId), eq(challengeClaims.status, 'active')))
        .returning();

      if (!updatedClaim) {
        continue;
      }

      const [updatedChallenge] = await db
        .update(challenges)
        .set({
          zoneId: isPortableChallengeConfig(row.challengeConfig) ? null : row.zoneId,
          status: 'available',
          currentClaimId: null,
          expiresAt: null,
          updatedAt: input.now,
        })
        .where(and(eq(challenges.id, row.challengeId), eq(challenges.currentClaimId, row.claimId)))
        .returning();

      if (!updatedChallenge) {
        continue;
      }

      const claim = serializeClaim(updatedClaim);
      const challenge = serializeChallenge(updatedChallenge);
      const { stateVersion } = await appendEvents(db, {
        gameId: row.gameId,
        events: [
          {
            eventType: eventTypes.objectiveStateChanged,
            entityType: 'challenge',
            entityId: row.challengeId,
            actorType: 'system',
            actorId: null,
            actorTeamId: row.teamId,
            beforeState: {
              status: row.challengeStatus,
              currentClaimId: row.challengeCurrentClaimId,
              expiresAt: toIsoTimestamp(row.challengeExpiresAt),
              zoneId: row.zoneId,
            },
            afterState: {
              status: updatedChallenge.status,
              currentClaimId: updatedChallenge.currentClaimId,
              expiresAt: updatedChallenge.expiresAt?.toISOString() ?? null,
              zoneId: updatedChallenge.zoneId,
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
            entityId: row.claimId,
            actorType: 'system',
            actorId: null,
            actorTeamId: row.teamId,
            afterState: claim as unknown as JsonValue,
            meta: {
              reason: 'expired',
              challengeId: row.challengeId,
            },
          },
        ],
      });

      expired.push({
        gameId: row.gameId,
        modeKey: row.modeKey,
        stateVersion,
        challenge,
        claim,
      });
    }

    return expired;
  });
}

async function warnClaimsBatch(
  input: Required<Pick<ClaimTimeoutSweepInput, 'db' | 'now'>> & { batchSize: number; warningWindowMs: number },
): Promise<Array<{ claimId: string; challengeId: string; gameId: string; teamId: string; expiresAt: Date }>> {
  return input.db.transaction(async (tx) => {
    const db = tx as unknown as DatabaseClient;
    const warningCutoff = new Date(input.now.getTime() + input.warningWindowMs);
    const lockedClaims = await db.execute<WarningClaimRow>(sql`
      SELECT
        claim.id AS "claimId",
        claim.challenge_id AS "challengeId",
        claim.game_id AS "gameId",
        claim.team_id AS "teamId",
        claim.expires_at AS "expiresAt"
      FROM challenge_claims AS claim
      INNER JOIN challenges AS challenge
        ON challenge.current_claim_id = claim.id
      WHERE claim.status = 'active'
        AND claim.warning_sent = FALSE
        AND claim.expires_at > ${input.now}
        AND claim.expires_at <= ${warningCutoff}
        AND challenge.status = 'claimed'
      ORDER BY claim.expires_at ASC
      FOR UPDATE OF claim SKIP LOCKED
      LIMIT ${input.batchSize}
    `);

    const warned: Array<{ claimId: string; challengeId: string; gameId: string; teamId: string; expiresAt: Date }> = [];

    for (const row of lockedClaims.rows) {
      const [updatedClaim] = await db
        .update(challengeClaims)
        .set({ warningSent: true })
        .where(and(eq(challengeClaims.id, row.claimId), eq(challengeClaims.warningSent, false)))
        .returning({ id: challengeClaims.id });

      if (!updatedClaim) {
        continue;
      }

      warned.push({
        claimId: row.claimId,
        challengeId: row.challengeId,
        gameId: row.gameId,
        teamId: row.teamId,
        expiresAt: toDate(row.expiresAt) ?? input.now,
      });
    }

    return warned;
  });
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

function toIsoTimestamp(value: Date | string | null | undefined): string | null {
  return toDate(value)?.toISOString() ?? null;
}
