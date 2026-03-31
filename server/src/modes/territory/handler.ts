import { eq } from 'drizzle-orm';
import {
  RESOURCE_TYPE_VALUES,
  STATE_VERSION_HEADER,
  errorCodes,
  resourceDefinitions,
  type GpsPayload,
  type ResourceType,
} from '@city-game/shared';
import { teams } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { seedInitialBalances } from '../../services/resource-service.js';
import type { ModeHandler, ModeResourceDefinition } from '../types.js';
import { claimChallenge } from './claim-service.js';
import { territoryRoutes } from './routes.js';

const territoryResourceDefinitions: ModeResourceDefinition[] = RESOURCE_TYPE_VALUES.map((resourceType) => ({
  type: resourceType,
  ...resourceDefinitions[resourceType],
  initialBalance: 0,
}));

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
        case 'complete':
        case 'release':
          throw new AppError(errorCodes.internalServerError, {
            message: 'Territory actions are not implemented yet.',
          });
      }
    },
    async checkWinCondition() {
      return {
        hasWinner: false,
        winnerTeamId: null,
      };
    },
    registerRoutes(app) {
      app.register(territoryRoutes);
    },
    getInitialResources() {
      return territoryResourceDefinitions.map((definition) => ({ ...definition }));
    },
    async computeScoreboard() {
      return [];
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
