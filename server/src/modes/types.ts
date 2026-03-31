import type { FastifyInstance } from 'fastify';
import type {
  GameStateSnapshot,
  ResourceDefinition,
  ResourceType,
  ScoreboardEntry,
} from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import type { games } from '../db/schema.js';

export type ModeGameRecord = typeof games.$inferSelect;

export interface ViewerContext {
  playerId: string;
  teamId: string | null;
  role?: string;
}

export interface ModeResourceDefinition extends ResourceDefinition {
  type: ResourceType;
  initialBalance: number;
}

export interface ModeContext {
  db: DatabaseClient;
}

export interface ModeActionInput {
  type: 'claim' | 'complete' | 'release';
  challengeId: string;
  payload?: unknown;
}

export interface ModeActionResult {
  statusCode: number;
  body?: unknown;
}

export interface WinCheckResult {
  hasWinner: boolean;
  winnerTeamId?: string | null;
  reason?: string;
}

export interface ModeHandler {
  readonly modeKey: string;
  onGameStart(input: { db: DatabaseClient; game: ModeGameRecord }): Promise<void>;
  onGameEnd(input: { db: DatabaseClient; game: ModeGameRecord }): Promise<void>;
  handleAction(action: ModeActionInput, context: ModeContext): Promise<ModeActionResult>;
  checkWinCondition(input: { db: DatabaseClient; game: ModeGameRecord }): Promise<WinCheckResult>;
  registerRoutes(app: FastifyInstance): void;
  getInitialResources(): ModeResourceDefinition[];
  computeScoreboard(input: { db: DatabaseClient; game: ModeGameRecord }): Promise<ScoreboardEntry[]>;
  filterStateForViewer(fullState: GameStateSnapshot, viewer: ViewerContext): GameStateSnapshot;
}
