import { and, asc, eq } from 'drizzle-orm';
import { isJudgedChallengeConfig, type ScoreboardEntry, type Team } from '@city-game/shared';
import { challengeClaims, challenges, teams } from '../../db/schema.js';
import { getAllBalances } from '../../services/resource-service.js';
import type { ModeHandler } from '../types.js';
import { createTerritoryModeHandler } from '../territory/handler.js';

export function createPointChallengeModeHandler(): ModeHandler {
  const base = createTerritoryModeHandler();
  return {
    ...base,
    modeKey: 'point_challenge',
    registerRoutes() {
      // The shared challenge routes dispatch to the active game's mode handler.
    },
    async computeScoreboard({ db, game }) {
      const [teamRows, balances] = await Promise.all([
        db.select().from(teams).where(eq(teams.gameId, game.id)).orderBy(asc(teams.createdAt)),
        getAllBalances(db, game.id),
      ]);
      return rankByPoints(teamRows.map((team) => ({
        team: serializeTeam(team),
        zoneCount: 0,
        resources: balances[team.id] ?? { points: 0, coins: 0 },
        rank: 0,
      })));
    },
    async checkWinCondition({ db, game }) {
      const [rows, teamRows, submissions] = await Promise.all([
        db.select({ id: challenges.id, status: challenges.status, config: challenges.config }).from(challenges).where(eq(challenges.gameId, game.id)),
        db.select({ id: teams.id }).from(teams).where(eq(teams.gameId, game.id)),
        db.select({ challengeId: challengeClaims.challengeId }).from(challengeClaims).where(and(eq(challengeClaims.gameId, game.id), eq(challengeClaims.status, 'submitted'))),
      ]);
      // Judged challenges never complete; they are finished once every team has submitted them.
      const submissionCounts = new Map<string, number>();
      for (const row of submissions) submissionCounts.set(row.challengeId, (submissionCounts.get(row.challengeId) ?? 0) + 1);
      const isOpen = (row: (typeof rows)[number]) => isJudgedChallengeConfig(row.config)
        ? row.status === 'available' && (submissionCounts.get(row.id) ?? 0) < teamRows.length
        : row.status === 'available' || row.status === 'claimed';
      if (rows.length === 0 || rows.some(isOpen)) {
        return { hasWinner: false };
      }
      // Judged points arrive after the game, so no winner can be named yet.
      if (rows.some((row) => isJudgedChallengeConfig(row.config))) {
        return { hasWinner: true, winnerTeamId: null, reason: 'awaiting_judging' };
      }
      const scoreboard = await this.computeScoreboard({ db, game });
      const winningPoints = scoreboard[0]?.resources.points ?? 0;
      const winners = scoreboard.filter((entry) => (entry.resources.points ?? 0) === winningPoints);
      return { hasWinner: true, winnerTeamId: winners.length === 1 ? winners[0]!.team.id : null, reason: 'all_point_challenges_completed' };
    },
  };
}

function rankByPoints(entries: ScoreboardEntry[]): ScoreboardEntry[] {
  return entries
    .sort((left, right) => (right.resources.points ?? 0) - (left.resources.points ?? 0) || left.team.name.localeCompare(right.team.name))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function serializeTeam(row: typeof teams.$inferSelect): Team {
  return {
    id: row.id, gameId: row.gameId, name: row.name, color: row.color as Team['color'],
    icon: row.icon, joinCode: row.joinCode, metadata: row.metadata as Team['metadata'],
    createdAt: row.createdAt.toISOString(),
  };
}
