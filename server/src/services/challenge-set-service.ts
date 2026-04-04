import { asc, eq, inArray } from 'drizzle-orm';
import type {
  ChallengeSet,
  ChallengeSetItem,
  GeoJsonPoint,
  JsonObject,
  ResourceAwardMap,
} from '@city-game/shared';
import { errorCodes } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { challengeSetItems, challengeSets, challenges, mapZones, maps, zones } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

interface ChallengeSetRow {
  id: string;
  name: string;
  description: string | null;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

interface ChallengeSetItemRow {
  id: string;
  setId: string;
  mapZoneId: string | null;
  title: string;
  description: string;
  kind: string;
  config: JsonObject;
  completionMode: string;
  scoring: ResourceAwardMap;
  difficulty: string | null;
  sortOrder: number;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChallengeSetInput {
  name: string;
  description?: string | null;
  metadata?: JsonObject;
}

export interface ChallengeSetUpdateInput {
  name?: string;
  description?: string | null;
  metadata?: JsonObject;
}

export interface ChallengeSetItemInput {
  setId: string;
  mapZoneId?: string | null;
  mapPoint?: GeoJsonPoint | null;
  title: string;
  description: string;
  kind?: string;
  config?: JsonObject;
  completionMode?: string;
  scoring?: ResourceAwardMap;
  difficulty?: string | null;
  sortOrder?: number;
  metadata?: JsonObject;
}

export interface ChallengeSetItemUpdateInput {
  mapZoneId?: string | null;
  mapPoint?: GeoJsonPoint | null;
  title?: string;
  description?: string;
  kind?: string;
  config?: JsonObject;
  completionMode?: string;
  scoring?: ResourceAwardMap;
  difficulty?: string | null;
  sortOrder?: number;
  metadata?: JsonObject;
}

export async function listChallengeSets(db: DatabaseClient): Promise<ChallengeSet[]> {
  const rows = await db.select(challengeSetSelectFields).from(challengeSets).orderBy(asc(challengeSets.createdAt));
  return rows.map((row) => serializeChallengeSetRow(row as ChallengeSetRow));
}

export async function getChallengeSetById(db: DatabaseClient, challengeSetId: string): Promise<ChallengeSet | null> {
  const [row] = await db.select(challengeSetSelectFields).from(challengeSets).where(eq(challengeSets.id, challengeSetId)).limit(1);
  return row ? serializeChallengeSetRow(row as ChallengeSetRow) : null;
}

export async function getChallengeSetByIdOrThrow(db: DatabaseClient, challengeSetId: string): Promise<ChallengeSet> {
  const challengeSet = await getChallengeSetById(db, challengeSetId);
  if (!challengeSet) {
    throw new AppError(errorCodes.challengeSetNotFound);
  }
  return challengeSet;
}

export async function createChallengeSet(db: DatabaseClient, input: ChallengeSetInput): Promise<ChallengeSet> {
  const [inserted] = await db.insert(challengeSets).values({
    name: input.name,
    description: normalizeNullableString(input.description),
    metadata: input.metadata ?? {},
  }).returning({ id: challengeSets.id });

  return getChallengeSetByIdOrThrow(db, inserted.id);
}

export async function updateChallengeSet(db: DatabaseClient, challengeSetId: string, input: ChallengeSetUpdateInput): Promise<ChallengeSet> {
  const existing = await getChallengeSetByIdOrThrow(db, challengeSetId);

  await db.update(challengeSets).set({
    name: input.name ?? existing.name,
    description: input.description === undefined ? existing.description : normalizeNullableString(input.description),
    metadata: input.metadata ?? existing.metadata,
    updatedAt: new Date(),
  }).where(eq(challengeSets.id, challengeSetId));

  return getChallengeSetByIdOrThrow(db, challengeSetId);
}

export async function deleteChallengeSetById(db: DatabaseClient, challengeSetId: string): Promise<boolean> {
  const [deleted] = await db.delete(challengeSets).where(eq(challengeSets.id, challengeSetId)).returning({ id: challengeSets.id });
  return Boolean(deleted);
}

export async function listChallengeSetItems(db: DatabaseClient, challengeSetId: string): Promise<ChallengeSetItem[]> {
  const rows = await db.select(challengeSetItemSelectFields)
    .from(challengeSetItems)
    .where(eq(challengeSetItems.setId, challengeSetId))
    .orderBy(asc(challengeSetItems.sortOrder), asc(challengeSetItems.createdAt));

  return rows.map((row) => serializeChallengeSetItemRow(row as ChallengeSetItemRow));
}

export async function getChallengeSetItemById(db: DatabaseClient, challengeSetItemId: string): Promise<ChallengeSetItem | null> {
  const [row] = await db.select(challengeSetItemSelectFields).from(challengeSetItems).where(eq(challengeSetItems.id, challengeSetItemId)).limit(1);
  return row ? serializeChallengeSetItemRow(row as ChallengeSetItemRow) : null;
}

export async function getChallengeSetItemByIdOrThrow(db: DatabaseClient, challengeSetItemId: string): Promise<ChallengeSetItem> {
  const item = await getChallengeSetItemById(db, challengeSetItemId);
  if (!item) {
    throw new AppError(errorCodes.validationError, { message: 'Challenge set item not found.' });
  }
  return item;
}

export async function createChallengeSetItem(db: DatabaseClient, input: ChallengeSetItemInput): Promise<ChallengeSetItem> {
  await getChallengeSetByIdOrThrow(db, input.setId);

  const nextMetadata = input.metadata ?? {};
  const sourceMapId = getSourceMapId(nextMetadata);
  const nextMapZoneId = input.mapZoneId ?? null;
  const nextMapPoint = input.mapPoint ?? null;

  await assertPlacementIsValid(db, { mapZoneId: nextMapZoneId, mapPoint: nextMapPoint, sourceMapId });

  const [inserted] = await db.insert(challengeSetItems).values({
    setId: input.setId,
    mapZoneId: nextMapZoneId,
    title: input.title,
    description: input.description,
    kind: input.kind ?? 'text',
    config: buildPersistedConfig(input.config ?? {}, nextMapZoneId, nextMapPoint),
    completionMode: input.completionMode ?? 'self_report',
    scoring: input.scoring ?? {},
    difficulty: normalizeNullableString(input.difficulty),
    sortOrder: input.sortOrder ?? 0,
    metadata: nextMetadata,
  }).returning({ id: challengeSetItems.id });

  return getChallengeSetItemByIdOrThrow(db, inserted.id);
}

export async function updateChallengeSetItem(db: DatabaseClient, challengeSetItemId: string, input: ChallengeSetItemUpdateInput): Promise<ChallengeSetItem> {
  const existing = await getChallengeSetItemByIdOrThrow(db, challengeSetItemId);
  const nextMetadata = input.metadata ?? existing.metadata;
  const sourceMapId = getSourceMapId(nextMetadata);
  const nextMapZoneId = input.mapZoneId === undefined ? existing.mapZoneId : input.mapZoneId;
  const nextMapPoint = input.mapPoint === undefined ? existing.mapPoint : input.mapPoint;

  await assertPlacementIsValid(db, { mapZoneId: nextMapZoneId, mapPoint: nextMapPoint, sourceMapId });

  await db.update(challengeSetItems).set({
    mapZoneId: nextMapZoneId,
    title: input.title ?? existing.title,
    description: input.description ?? existing.description,
    kind: input.kind ?? existing.kind,
    config: buildPersistedConfig(input.config ?? existing.config, nextMapZoneId, nextMapPoint),
    completionMode: input.completionMode ?? existing.completionMode,
    scoring: input.scoring ?? existing.scoring,
    difficulty: input.difficulty === undefined ? existing.difficulty : normalizeNullableString(input.difficulty),
    sortOrder: input.sortOrder ?? existing.sortOrder,
    metadata: nextMetadata,
    updatedAt: new Date(),
  }).where(eq(challengeSetItems.id, challengeSetItemId));

  return getChallengeSetItemByIdOrThrow(db, challengeSetItemId);
}

export async function deleteChallengeSetItemById(db: DatabaseClient, challengeSetItemId: string): Promise<boolean> {
  const [deleted] = await db.delete(challengeSetItems).where(eq(challengeSetItems.id, challengeSetItemId)).returning({ id: challengeSetItems.id });
  return Boolean(deleted);
}

export async function cloneChallengeSetToGame(
  db: DatabaseClient,
  challengeSetId: string,
  gameId: string,
  activeChallengeCount: number,
): Promise<number> {
  const existingRuntimeChallenges = await db.select({ id: challenges.id }).from(challenges).where(eq(challenges.gameId, gameId)).limit(1);
  if (existingRuntimeChallenges.length > 0) {
    return 0;
  }

  const items = await listChallengeSetItems(db, challengeSetId);
  if (items.length === 0) {
    return 0;
  }

  const runtimeZoneRows = await db.select({ id: zones.id, metadata: zones.metadata }).from(zones).where(eq(zones.gameId, gameId));
  const runtimeZoneIdByMapZoneId = new Map<string, string>();
  for (const row of runtimeZoneRows) {
    const sourceMapZoneId = typeof (row.metadata as JsonObject | null)?.source_map_zone_id === 'string'
      ? String((row.metadata as JsonObject).source_map_zone_id)
      : null;
    if (sourceMapZoneId) {
      runtimeZoneIdByMapZoneId.set(sourceMapZoneId, row.id);
    }
  }

  const insertedChallengeIds: string[] = [];

  for (const item of items) {
    let runtimeZoneId: string | null = null;
    if (item.mapZoneId) {
      runtimeZoneId = runtimeZoneIdByMapZoneId.get(item.mapZoneId) ?? null;
      if (!runtimeZoneId) {
        throw new AppError(errorCodes.validationError, {
          message: 'Challenge set item could not resolve its authored zone for this game map.',
          details: {
            challengeSetId,
            challengeSetItemId: item.id,
            mapZoneId: item.mapZoneId,
            gameId,
          },
        });
      }
    }

    const [insertedChallenge] = await db.insert(challenges).values({
      gameId,
      zoneId: runtimeZoneId,
      title: item.title,
      description: item.description,
      kind: item.kind,
      config: {
        ...item.config,
        portable: !item.mapZoneId && !item.mapPoint,
        location_mode: getLocationMode(item),
        source_challenge_set_id: challengeSetId,
        source_challenge_set_item_id: item.id,
        source_map_zone_id: item.mapZoneId,
        ...(item.mapPoint ? { source_map_point: item.mapPoint } : {}),
        ...(item.metadata && Object.keys(item.metadata).length > 0 ? { source_metadata: item.metadata } : {}),
      },
      completionMode: item.completionMode,
      scoring: item.scoring,
      difficulty: item.difficulty,
      sortOrder: item.sortOrder,
      isDeckActive: false,
      status: 'available',
    }).returning({ id: challenges.id });

    insertedChallengeIds.push(insertedChallenge.id);
  }

  const initialActiveIds = insertedChallengeIds.slice(0, Math.max(1, activeChallengeCount));
  if (initialActiveIds.length > 0) {
    await db.update(challenges).set({
      isDeckActive: true,
      updatedAt: new Date(),
    }).where(inArray(challenges.id, initialActiveIds));
  }

  return items.length;
}

function getLocationMode(item: { mapZoneId: string | null; mapPoint: GeoJsonPoint | null }): 'portable' | 'zone' | 'point' {
  if (item.mapZoneId) {
    return 'zone';
  }
  if (item.mapPoint) {
    return 'point';
  }
  return 'portable';
}

function buildPersistedConfig(config: JsonObject, mapZoneId: string | null, mapPoint: GeoJsonPoint | null): JsonObject {
  const nextConfig: JsonObject = { ...config };
  delete nextConfig.map_point;
  delete nextConfig.location_mode;

  if (mapPoint) {
    nextConfig.map_point = mapPoint as unknown as JsonObject;
  }
  nextConfig.location_mode = getLocationMode({ mapZoneId, mapPoint });

  return nextConfig;
}

async function assertPlacementIsValid(
  db: DatabaseClient,
  input: { mapZoneId: string | null; mapPoint: GeoJsonPoint | null; sourceMapId: string | null },
): Promise<void> {
  if (input.mapZoneId && input.mapPoint) {
    throw new AppError(errorCodes.validationError, { message: 'Choose either a source zone or a source point, not both.' });
  }

  if (input.mapZoneId) {
    const [row] = await db.select({ id: mapZones.id, mapId: mapZones.mapId }).from(mapZones).where(eq(mapZones.id, input.mapZoneId)).limit(1);
    if (!row) {
      throw new AppError(errorCodes.validationError, { message: 'Map zone not found.' });
    }
    if (input.sourceMapId && row.mapId !== input.sourceMapId) {
      throw new AppError(errorCodes.validationError, { message: 'Selected source zone does not belong to the chosen map.' });
    }
    return;
  }

  if (input.mapPoint) {
    if (!input.sourceMapId) {
      throw new AppError(errorCodes.validationError, { message: 'Point-linked challenges require a source map.' });
    }
    if (!isGeoJsonPoint(input.mapPoint)) {
      throw new AppError(errorCodes.validationError, { message: 'Point-linked challenges require a valid map point.' });
    }
    const [mapRow] = await db.select({ id: maps.id }).from(maps).where(eq(maps.id, input.sourceMapId)).limit(1);
    if (!mapRow) {
      throw new AppError(errorCodes.validationError, { message: 'Source map not found.' });
    }
  }
}

function getSourceMapId(metadata: JsonObject): string | null {
  const raw = metadata.sourceMapId;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function isGeoJsonPoint(value: unknown): value is GeoJsonPoint {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as GeoJsonPoint;
  return candidate.type === 'Point'
    && Array.isArray(candidate.coordinates)
    && candidate.coordinates.length >= 2
    && typeof candidate.coordinates[0] === 'number'
    && typeof candidate.coordinates[1] === 'number';
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return value ?? null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const challengeSetSelectFields = {
  id: challengeSets.id,
  name: challengeSets.name,
  description: challengeSets.description,
  metadata: challengeSets.metadata,
  createdAt: challengeSets.createdAt,
  updatedAt: challengeSets.updatedAt,
};

const challengeSetItemSelectFields = {
  id: challengeSetItems.id,
  setId: challengeSetItems.setId,
  mapZoneId: challengeSetItems.mapZoneId,
  title: challengeSetItems.title,
  description: challengeSetItems.description,
  kind: challengeSetItems.kind,
  config: challengeSetItems.config,
  completionMode: challengeSetItems.completionMode,
  scoring: challengeSetItems.scoring,
  difficulty: challengeSetItems.difficulty,
  sortOrder: challengeSetItems.sortOrder,
  metadata: challengeSetItems.metadata,
  createdAt: challengeSetItems.createdAt,
  updatedAt: challengeSetItems.updatedAt,
};

function serializeChallengeSetRow(row: ChallengeSetRow): ChallengeSet {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeChallengeSetItemRow(row: ChallengeSetItemRow): ChallengeSetItem {
  return {
    id: row.id,
    setId: row.setId,
    mapZoneId: row.mapZoneId,
    mapPoint: isGeoJsonPoint(row.config?.map_point) ? row.config.map_point : null,
    title: row.title,
    description: row.description,
    kind: row.kind as ChallengeSetItem['kind'],
    config: row.config,
    completionMode: row.completionMode,
    scoring: row.scoring,
    difficulty: row.difficulty as ChallengeSetItem['difficulty'],
    sortOrder: row.sortOrder,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
