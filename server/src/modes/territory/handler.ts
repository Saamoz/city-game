import { asc, eq, sql } from 'drizzle-orm';
import {
  RESOURCE_TYPE_VALUES,
  STATE_VERSION_HEADER,
  errorCodes,
  resourceDefinitions,
  type Challenge,
  type ChallengeClaim,
  type GpsPayload,
  type Team,
  type JsonObject,
  type JsonValue,
  type ResourceAwardMap,
  type ResourceLedgerEntry,
  type ResourceType,
  type Zone,
} from '@city-game/shared';
import { teams, zones } from '../../db/schema.js';
import { AppError, buildErrorResponse } from '../../lib/errors.js';
import { getAllBalances, seedInitialBalances } from '../../services/resource-service.js';
import type { ModeHandler, ModeResourceDefinition } from '../types.js';
import { claimChallenge } from './claim-service.js';
import { completeChallenge } from './complete-service.js';
import { releaseChallenge } from './release-service.js';
import { territoryRoutes } from './routes.js';
import { evaluateTerritoryWinCondition } from './win-conditions.js';

const territoryResourceDefinitions: ModeResourceDefinition[] = RESOURCE_TYPE_VALUES.map((resourceType) => ({
  type: resourceType,
  ...resourceDefinitions[resourceType],
  initialBalance: 0,
}));

export interface TerritoryChallengeReleasedPostCommit {
  type: 'challenge_released';
  gameId: string;
  stateVersion: number;
  challenge: Challenge;
  claim: ChallengeClaim;
}

export interface TerritoryChallengeCompletedPostCommit {
  type: 'challenge_completed';
  gameId: string;
  stateVersion: number;
  challenge: Challenge;
  claim: ChallengeClaim;
  zone: Zone | null;
  activatedChallenge: Challenge | null;
  resourcesAwarded: ResourceAwardMap;
  resourceEntries: ResourceLedgerEntry[];
}

export type TerritoryPostCommitData = TerritoryChallengeReleasedPostCommit | TerritoryChallengeCompletedPostCommit;

export function createTerritoryModeHandler(): ModeHandler {
  return {
    modeKey: 'territory',
    async onGameStart({ db, game }) {
      const gameTeams = await db.select({ id: teams.id }).from(teams).where(eq(teams.gameId, game.id));

      await seedInitialBalances(db, {
        gameId: game.id,
        teamIds: gameTeams.map((team) => team.id),
        balances: buildInitialBalanceMap(territoryResourceDefinitions),
        reason: 'game_start_seed',
        includeZeroBalances: true,
      });
    },
    async onGameEnd() {
      return;
    },
    async handleAction(action, context) {
      switch (action.type) {
        case 'claim': {
          const gpsPayload = action.payload;
          if (!isGpsPayload(gpsPayload)) {
            throw new AppError(errorCodes.validationError, {
              message: 'GPS payload is required for claim actions.',
            });
          }

          const result = await claimChallenge(context.db, {
            challengeId: action.challengeId,
            gameId: action.gameId,
            playerId: action.playerId,
            teamId: action.teamId,
            gpsPayload,
          });

          return {
            gameId: result.gameId,
            statusCode: 200,
            stateVersion: result.stateVersion,
            body: {
              challenge: result.challenge,
              claim: result.claim,
              stateVersion: result.stateVersion,
            },
            responseHeaders: {
              [STATE_VERSION_HEADER]: String(result.stateVersion),
            },
          };
        }
        case 'complete': {
          const result = await completeChallenge(context.db, {
            challengeId: action.challengeId,
            gameId: action.gameId,
            playerId: action.playerId,
            teamId: action.teamId,
            submission: getCompletionSubmission(action.payload),
            gpsPayload: getCompletionGps(action.payload),
          });

          if (result.kind === 'expired') {
            return {
              gameId: result.gameId,
              statusCode: 409,
              stateVersion: result.stateVersion,
              body: buildErrorResponse(errorCodes.claimExpired),
              responseHeaders: {
                [STATE_VERSION_HEADER]: String(result.stateVersion),
              },
              postCommitData: {
                type: 'challenge_released',
                gameId: result.gameId,
                stateVersion: result.stateVersion,
                challenge: result.challenge,
                claim: result.claim,
              } satisfies TerritoryChallengeReleasedPostCommit,
            };
          }

          return {
            gameId: result.gameId,
            statusCode: 200,
            stateVersion: result.stateVersion,
            body: {
              challenge: result.challenge,
              claim: result.claim,
              zone: result.zone,
              activatedChallenge: result.activatedChallenge,
              resourcesAwarded: result.resourcesAwarded,
              stateVersion: result.stateVersion,
            },
            responseHeaders: {
              [STATE_VERSION_HEADER]: String(result.stateVersion),
            },
            postCommitData: {
              type: 'challenge_completed',
              gameId: result.gameId,
              stateVersion: result.stateVersion,
              challenge: result.challenge,
              claim: result.claim,
              zone: result.zone,
              activatedChallenge: result.activatedChallenge,
              resourcesAwarded: result.resourcesAwarded,
              resourceEntries: result.resourceEntries,
            } satisfies TerritoryChallengeCompletedPostCommit,
          };
        }
        case 'release': {
          const result = await releaseChallenge(context.db, {
            challengeId: action.challengeId,
            gameId: action.gameId,
            playerId: action.playerId,
            teamId: action.teamId,
          });

          return {
            gameId: result.gameId,
            statusCode: 200,
            stateVersion: result.stateVersion,
            body: {
              challenge: result.challenge,
              claim: result.claim,
              stateVersion: result.stateVersion,
            },
            responseHeaders: {
              [STATE_VERSION_HEADER]: String(result.stateVersion),
            },
            postCommitData: {
              type: 'challenge_released',
              gameId: result.gameId,
              stateVersion: result.stateVersion,
              challenge: result.challenge,
              claim: result.claim,
            } satisfies TerritoryChallengeReleasedPostCommit,
          };
        }
      }
    },
    async checkWinCondition({ db, game, now }) {
      return evaluateTerritoryWinCondition(db, game, now ?? new Date());
    },
    registerRoutes(app) {
      app.register(territoryRoutes);
    },
    getInitialResources() {
      return territoryResourceDefinitions.map((definition) => ({ ...definition }));
    },
    async computeScoreboard({ db, game }) {
      const [teamRows, balancesByTeam, zoneCountRows] = await Promise.all([
        db.select().from(teams).where(eq(teams.gameId, game.id)).orderBy(asc(teams.createdAt)),
        getAllBalances(db, game.id),
        db.execute<{ teamId: string; zoneCount: number }>(sql`
          SELECT owner_team_id AS "teamId", COUNT(*)::int AS "zoneCount"
          FROM ${zones}
          WHERE game_id = ${game.id}
            AND owner_team_id IS NOT NULL
            AND is_disabled = FALSE
          GROUP BY owner_team_id
        `),
      ]);

      const zoneCountsByTeamId = new Map(zoneCountRows.rows.map((row) => [row.teamId, row.zoneCount]));
      const rankedEntries = teamRows
        .map((team) => ({
          team: {
            id: team.id,
            gameId: team.gameId,
            name: team.name,
            color: team.color as Team['color'],
            icon: team.icon,
            joinCode: team.joinCode,
            metadata: team.metadata as Team['metadata'],
            createdAt: team.createdAt.toISOString(),
          },
          zoneCount: zoneCountsByTeamId.get(team.id) ?? 0,
          resources: balancesByTeam[team.id] ?? { points: 0, coins: 0 },
        }))
        .sort((left, right) => {
          const zoneDelta = right.zoneCount - left.zoneCount;
          if (zoneDelta !== 0) {
            return zoneDelta;
          }

          const nameCompare = left.team.name.localeCompare(right.team.name);
          if (nameCompare !== 0) {
            return nameCompare;
          }

          return left.team.id.localeCompare(right.team.id);
        });

      return rankedEntries.map((entry, index) => ({
        ...entry,
        rank: index + 1,
      }));
    },
    filterStateForViewer(fullState) {
      return fullState;
    },
  };
}

function buildInitialBalanceMap(definitions: ModeResourceDefinition[]): Partial<Record<ResourceType, number>> {
  return Object.fromEntries(definitions.map((definition) => [definition.type, definition.initialBalance])) as Partial<
    Record<ResourceType, number>
  >;
}

function isGpsPayload(value: unknown): value is GpsPayload {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as GpsPayload).lat === 'number' &&
      typeof (value as GpsPayload).lng === 'number' &&
      typeof (value as GpsPayload).gpsErrorMeters === 'number' &&
      typeof (value as GpsPayload).capturedAt === 'string',
  );
}

function getCompletionSubmission(value: unknown): JsonValue | null {
  if (!isJsonObject(value) || !('submission' in value)) {
    return null;
  }

  return (value.submission as JsonValue | undefined) ?? null;
}


function getCompletionGps(value: unknown): GpsPayload | null {
  if (!isJsonObject(value) || !('gps' in value)) {
    return null;
  }

  return isGpsPayload(value.gps) ? value.gps : null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
