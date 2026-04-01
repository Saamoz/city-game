import { and, asc, eq } from 'drizzle-orm';
import type { Game, WinCondition } from '@city-game/shared';
import type { DatabaseClient } from '../../db/connection.js';
import { teams, zones } from '../../db/schema.js';
import { getAllBalances } from '../../services/resource-service.js';
import type { ModeGameRecord, WinCheckResult } from '../types.js';

interface TerritoryStanding {
  teamId: string;
  zoneCount: number;
  points: number;
  createdAt: Date;
}

interface TerritoryEvaluationContext {
  totalEnabledZones: number;
  standings: TerritoryStanding[];
  scoreStandings: TerritoryStanding[];
}

export async function evaluateTerritoryWinCondition(
  db: DatabaseClient,
  game: ModeGameRecord,
  now: Date = new Date(),
): Promise<WinCheckResult> {
  const winConditions = (game.winCondition as Game['winCondition']) ?? [];

  if (winConditions.length === 0) {
    return { hasWinner: false, winnerTeamId: null, winCondition: null };
  }

  let context: TerritoryEvaluationContext | null = null;

  for (const condition of winConditions) {
    context ??= await buildEvaluationContext(db, game.id);
    const result = evaluateCondition(game, condition, context, now);

    if (result.hasWinner) {
      return result;
    }
  }

  return {
    hasWinner: false,
    winnerTeamId: null,
    winCondition: null,
  };
}

async function buildEvaluationContext(db: DatabaseClient, gameId: string): Promise<TerritoryEvaluationContext> {
  const teamRows = await db
    .select({ id: teams.id, createdAt: teams.createdAt })
    .from(teams)
    .where(eq(teams.gameId, gameId))
    .orderBy(asc(teams.createdAt));
  const zoneRows = await db
    .select({ ownerTeamId: zones.ownerTeamId })
    .from(zones)
    .where(and(eq(zones.gameId, gameId), eq(zones.isDisabled, false)));
  const balancesByTeam = await getAllBalances(db, gameId);

  const zoneCountByTeamId = new Map<string, number>();

  for (const zone of zoneRows) {
    if (!zone.ownerTeamId) {
      continue;
    }

    zoneCountByTeamId.set(zone.ownerTeamId, (zoneCountByTeamId.get(zone.ownerTeamId) ?? 0) + 1);
  }

  const standings = teamRows
    .map((team) => ({
      teamId: team.id,
      zoneCount: zoneCountByTeamId.get(team.id) ?? 0,
      points: balancesByTeam[team.id]?.points ?? 0,
      createdAt: team.createdAt,
    }))
    .sort(compareZoneStandings);

  return {
    totalEnabledZones: zoneRows.length,
    standings,
    scoreStandings: [...standings].sort(compareScoreStandings),
  };
}

function evaluateCondition(
  game: ModeGameRecord,
  condition: WinCondition,
  context: TerritoryEvaluationContext,
  now: Date,
): WinCheckResult {
  switch (condition.type) {
    case 'all_zones':
      return evaluateAllZones(condition, context);
    case 'zone_majority':
      return evaluateZoneMajority(condition, context);
    case 'score_threshold':
      return evaluateScoreThreshold(condition, context);
    case 'time_limit':
      return evaluateTimeLimit(game, condition, context, now);
  }
}

function evaluateAllZones(
  condition: Extract<WinCondition, { type: 'all_zones' }>,
  context: TerritoryEvaluationContext,
): WinCheckResult {
  if (context.totalEnabledZones === 0) {
    return unmet();
  }

  const winner = context.standings.find((entry) => entry.zoneCount === context.totalEnabledZones);

  if (!winner) {
    return unmet();
  }

  return met({
    winnerTeamId: winner.teamId,
    reason: 'all_zones',
    winCondition: condition,
  });
}

function evaluateZoneMajority(
  condition: Extract<WinCondition, { type: 'zone_majority' }>,
  context: TerritoryEvaluationContext,
): WinCheckResult {
  if (context.totalEnabledZones === 0) {
    return unmet();
  }

  const leader = context.standings[0];
  const runnerUp = context.standings[1];

  if (!leader || leader.zoneCount === 0) {
    return unmet();
  }

  const share = leader.zoneCount / context.totalEnabledZones;
  const hasUniqueLead = leader.zoneCount > (runnerUp?.zoneCount ?? -1);

  if (share < condition.threshold || !hasUniqueLead) {
    return unmet();
  }

  return met({
    winnerTeamId: leader.teamId,
    reason: 'zone_majority',
    winCondition: condition,
  });
}

function evaluateScoreThreshold(
  condition: Extract<WinCondition, { type: 'score_threshold' }>,
  context: TerritoryEvaluationContext,
): WinCheckResult {
  const leader = context.scoreStandings[0];
  const runnerUp = context.scoreStandings[1];

  if (!leader || leader.points < condition.target) {
    return unmet();
  }

  const hasUniqueLead = leader.points > (runnerUp?.points ?? Number.NEGATIVE_INFINITY);

  if (!hasUniqueLead) {
    return unmet();
  }

  return met({
    winnerTeamId: leader.teamId,
    reason: 'score_threshold',
    winCondition: condition,
  });
}

function evaluateTimeLimit(
  game: ModeGameRecord,
  condition: Extract<WinCondition, { type: 'time_limit' }>,
  context: TerritoryEvaluationContext,
  now: Date,
): WinCheckResult {
  if (!game.startedAt) {
    return unmet();
  }

  const expiresAt = new Date(game.startedAt.getTime() + condition.duration_minutes * 60_000);

  if (expiresAt > now) {
    return unmet();
  }

  const leader = context.standings[0];
  const runnerUp = context.standings[1];

  if (!leader) {
    return met({
      winnerTeamId: null,
      reason: 'time_limit',
      winCondition: condition,
    });
  }

  const isTied = Boolean(runnerUp && leader.zoneCount === runnerUp.zoneCount && leader.points === runnerUp.points);

  return met({
    winnerTeamId: isTied ? null : leader.teamId,
    reason: isTied ? 'time_limit_tie' : 'time_limit',
    winCondition: condition,
  });
}

function compareZoneStandings(left: TerritoryStanding, right: TerritoryStanding): number {
  return (
    right.zoneCount - left.zoneCount ||
    right.points - left.points ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.teamId.localeCompare(right.teamId)
  );
}

function compareScoreStandings(left: TerritoryStanding, right: TerritoryStanding): number {
  return (
    right.points - left.points ||
    right.zoneCount - left.zoneCount ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.teamId.localeCompare(right.teamId)
  );
}

function met(input: { winnerTeamId: string | null; reason: string; winCondition: WinCondition }): WinCheckResult {
  return {
    hasWinner: true,
    winnerTeamId: input.winnerTeamId,
    reason: input.reason,
    winCondition: input.winCondition,
  };
}

function unmet(): WinCheckResult {
  return {
    hasWinner: false,
    winnerTeamId: null,
    winCondition: null,
  };
}
