import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type {
  ResourceLedgerEntry,
  TeamResourceBalances,
  TeamResourcesByTeam,
} from '@city-game/shared';
import { RESOURCE_TYPE_VALUES, errorCodes, type ResourceType } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { resourceLedger, teams } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

interface ResourceLedgerRow {
  id: string;
  gameId: string;
  teamId: string;
  playerId: string | null;
  resourceType: ResourceType;
  delta: number;
  balanceAfter: number;
  sequence: number;
  reason: string;
  referenceId: string | null;
  referenceType: string | null;
  createdAt: Date;
}

export interface ResourceScopeInput {
  gameId: string;
  teamId: string;
  playerId?: string | null;
  resourceType: ResourceType;
}

export interface ResourceTransactionInput extends ResourceScopeInput {
  delta: number;
  reason: string;
  referenceId?: string | null;
  referenceType?: string | null;
  allowNegative?: boolean;
}

export interface ResourceHistoryInput {
  gameId: string;
  teamId: string;
  playerId?: string | null;
  resourceType?: ResourceType;
  limit?: number;
}

export interface InitialBalanceSeedInput {
  gameId: string;
  teamIds: string[];
  balances: Partial<Record<ResourceType, number>>;
  reason?: string;
}

export async function getBalance(db: DatabaseClient, input: ResourceScopeInput): Promise<number> {
  const [row] = await db
    .select({ balanceAfter: resourceLedger.balanceAfter })
    .from(resourceLedger)
    .where(buildScopeCondition(input))
    .orderBy(desc(resourceLedger.sequence))
    .limit(1);

  return row?.balanceAfter ?? 0;
}

export async function getTeamBalances(
  db: DatabaseClient,
  input: Pick<ResourceHistoryInput, 'gameId' | 'teamId' | 'playerId'>,
): Promise<TeamResourceBalances> {
  const rows = await db
    .select({
      resourceType: resourceLedger.resourceType,
      balanceAfter: resourceLedger.balanceAfter,
    })
    .from(resourceLedger)
    .where(
      and(
        eq(resourceLedger.gameId, input.gameId),
        eq(resourceLedger.teamId, input.teamId),
        input.playerId ? eq(resourceLedger.playerId, input.playerId) : isNull(resourceLedger.playerId),
      ),
    )
    .orderBy(desc(resourceLedger.sequence));

  const balances = createEmptyBalances();
  const seenResourceTypes = new Set<ResourceType>();

  for (const row of rows) {
    const resourceType = row.resourceType as ResourceType;

    if (!seenResourceTypes.has(resourceType)) {
      balances[resourceType] = row.balanceAfter;
      seenResourceTypes.add(resourceType);
    }
  }

  return balances;
}

export async function getAllBalances(db: DatabaseClient, gameId: string): Promise<TeamResourcesByTeam> {
  const teamRows = await db.select({ id: teams.id }).from(teams).where(eq(teams.gameId, gameId));
  const balancesByTeam = Object.fromEntries(teamRows.map((team) => [team.id, createEmptyBalances()])) as TeamResourcesByTeam;

  const latestRows = await db.execute<{
    teamId: string;
    resourceType: ResourceType;
    balanceAfter: number;
  }>(sql`
    SELECT DISTINCT ON (team_id, resource_type)
      team_id AS "teamId",
      resource_type AS "resourceType",
      balance_after AS "balanceAfter"
    FROM resource_ledger
    WHERE game_id = ${gameId}
      AND player_id IS NULL
    ORDER BY team_id, resource_type, sequence DESC
  `);

  for (const row of latestRows.rows) {
    if (!balancesByTeam[row.teamId]) {
      balancesByTeam[row.teamId] = createEmptyBalances();
    }

    balancesByTeam[row.teamId][row.resourceType] = row.balanceAfter;
  }

  return balancesByTeam;
}

export async function getHistory(db: DatabaseClient, input: ResourceHistoryInput): Promise<ResourceLedgerEntry[]> {
  const rows = await db
    .select()
    .from(resourceLedger)
    .where(
      and(
        eq(resourceLedger.gameId, input.gameId),
        eq(resourceLedger.teamId, input.teamId),
        input.playerId ? eq(resourceLedger.playerId, input.playerId) : isNull(resourceLedger.playerId),
        input.resourceType ? eq(resourceLedger.resourceType, input.resourceType) : undefined,
      ),
    )
    .orderBy(desc(resourceLedger.sequence), desc(resourceLedger.createdAt))
    .limit(input.limit ?? 50);

  return rows.map((row) => serializeResourceLedgerEntry(row as ResourceLedgerRow));
}

export async function transact(db: DatabaseClient, input: ResourceTransactionInput): Promise<ResourceLedgerEntry> {
  return db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as DatabaseClient;
    await lockResourceScope(transactionalDb, input);

    const [latestRow] = await transactionalDb
      .select({
        sequence: resourceLedger.sequence,
        balanceAfter: resourceLedger.balanceAfter,
      })
      .from(resourceLedger)
      .where(buildScopeCondition(input))
      .orderBy(desc(resourceLedger.sequence))
      .limit(1);

    const nextSequence = (latestRow?.sequence ?? 0) + 1;
    const nextBalance = (latestRow?.balanceAfter ?? 0) + input.delta;

    if (nextBalance < 0 && !input.allowNegative) {
      throw new AppError(errorCodes.insufficientResources, {
        message: 'Insufficient resources.',
        details: {
          resourceType: input.resourceType,
          balance: latestRow?.balanceAfter ?? 0,
          attemptedDelta: input.delta,
        },
      });
    }

    const [entry] = await transactionalDb
      .insert(resourceLedger)
      .values({
        gameId: input.gameId,
        teamId: input.teamId,
        playerId: input.playerId ?? null,
        resourceType: input.resourceType,
        delta: input.delta,
        balanceAfter: nextBalance,
        sequence: nextSequence,
        reason: input.reason,
        referenceId: input.referenceId ?? null,
        referenceType: input.referenceType ?? null,
      })
      .returning();

    return serializeResourceLedgerEntry(entry as ResourceLedgerRow);
  });
}

export async function seedInitialBalances(
  db: DatabaseClient,
  input: InitialBalanceSeedInput,
): Promise<ResourceLedgerEntry[]> {
  const entries: ResourceLedgerEntry[] = [];

  for (const teamId of input.teamIds) {
    for (const resourceType of RESOURCE_TYPE_VALUES) {
      const amount = input.balances[resourceType] ?? 0;

      if (amount === 0) {
        continue;
      }

      entries.push(
        await transact(db, {
          gameId: input.gameId,
          teamId,
          resourceType,
          delta: amount,
          reason: input.reason ?? 'game_start_seed',
        }),
      );
    }
  }

  return entries;
}

async function lockResourceScope(db: DatabaseClient, input: ResourceScopeInput) {
  if (input.playerId) {
    const result = await db.execute<{ id: string }>(sql`
      SELECT id
      FROM players
      WHERE id = ${input.playerId}
        AND game_id = ${input.gameId}
        AND team_id = ${input.teamId}
      FOR UPDATE
    `);

    if (!result.rows[0]) {
      throw new AppError(errorCodes.validationError, {
        message: 'Player was not found for this team.',
      });
    }

    return;
  }

  const result = await db.execute<{ id: string }>(sql`
    SELECT id
    FROM teams
    WHERE id = ${input.teamId}
      AND game_id = ${input.gameId}
    FOR UPDATE
  `);

  if (!result.rows[0]) {
    throw new AppError(errorCodes.teamNotFound);
  }
}

function buildScopeCondition(input: ResourceScopeInput) {
  return and(
    eq(resourceLedger.gameId, input.gameId),
    eq(resourceLedger.teamId, input.teamId),
    eq(resourceLedger.resourceType, input.resourceType),
    input.playerId ? eq(resourceLedger.playerId, input.playerId) : isNull(resourceLedger.playerId),
  );
}

function createEmptyBalances(): TeamResourceBalances {
  return Object.fromEntries(RESOURCE_TYPE_VALUES.map((resourceType) => [resourceType, 0])) as TeamResourceBalances;
}

function serializeResourceLedgerEntry(row: ResourceLedgerRow): ResourceLedgerEntry {
  return {
    id: row.id,
    gameId: row.gameId,
    teamId: row.teamId,
    playerId: row.playerId,
    resourceType: row.resourceType,
    delta: row.delta,
    balanceAfter: row.balanceAfter,
    sequence: row.sequence,
    reason: row.reason,
    referenceId: row.referenceId,
    referenceType: row.referenceType,
    createdAt: row.createdAt.toISOString(),
  };
}
