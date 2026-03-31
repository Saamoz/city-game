import { eq } from 'drizzle-orm';
import {
  RESOURCE_TYPE_VALUES,
  errorCodes,
  resourceDefinitions,
  type ResourceType,
} from '@city-game/shared';
import { teams } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { seedInitialBalances } from '../../services/resource-service.js';
import type { ModeHandler, ModeResourceDefinition } from '../types.js';
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
    async handleAction() {
      throw new AppError(errorCodes.internalServerError, {
        message: 'Territory actions are not implemented yet.',
      });
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
