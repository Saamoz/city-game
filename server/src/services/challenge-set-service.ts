import { asc, eq, inArray, sql } from 'drizzle-orm';
import type {
  ChallengeSet,
  ChallengeSetItem,
  GeoJsonPoint,
  JsonObject,
  ResourceAwardMap,
} from '@city-game/shared';
import { MAX_CHALLENGE_BONUSES, errorCodes, getChallengeArea, isAreaGeometry, isJudgedChallengeConfig } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { challengeSetItems, challengeSets, challenges, mapZones, maps, zones } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

interface ChallengeSetRow {
  id: string;
  name: string;
  description: string | null;
  mapId: string | null;
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
  locationMode?: 'portable' | 'zone' | 'point';
  mapId?: string | null;
  name: string;
  description?: string | null;
  metadata?: JsonObject;
}

export interface ChallengeSetUpdateInput {
  locationMode?: 'portable' | 'zone' | 'point';
  mapId?: string | null;
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
  if (input.mapId) await assertMapExists(db, input.mapId);
  const [inserted] = await db.insert(challengeSets).values({
    name: input.name,
    description: normalizeNullableString(input.description),
    mapId: input.mapId ?? null,
    metadata: { ...(input.metadata ?? {}), locationMode: input.locationMode ?? 'portable' },
  }).returning({ id: challengeSets.id });

  return getChallengeSetByIdOrThrow(db, inserted.id);
}

export async function updateChallengeSet(db: DatabaseClient, challengeSetId: string, input: ChallengeSetUpdateInput): Promise<ChallengeSet> {
  const existing = await getChallengeSetByIdOrThrow(db, challengeSetId);
  const nextMapId = input.mapId === undefined ? existing.mapId : input.mapId;
  if (nextMapId !== existing.mapId) await assertSetCanMoveToMap(db, challengeSetId, nextMapId);

  await db.update(challengeSets).set({
    name: input.name ?? existing.name,
    description: input.description === undefined ? existing.description : normalizeNullableString(input.description),
    mapId: nextMapId,
    metadata: { ...(input.metadata ?? existing.metadata), locationMode: input.locationMode ?? existing.locationMode },
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
  const challengeSet = await getChallengeSetByIdOrThrow(db, input.setId);

  const nextMapZoneId = input.mapZoneId ?? null;
  const nextMapPoint = input.mapPoint ?? null;
  const nextConfig = input.config ?? {};

  assertPlacementMatchesSet(challengeSet.locationMode, nextMapZoneId, nextMapPoint);
  assertBonusLimit(input.config);
  await assertAreaIsValid(db, challengeSet.locationMode, nextConfig, nextMapZoneId, nextMapPoint);
  const nextMetadata = await resolveItemMap(db, challengeSet, input.metadata ?? {}, { mapZoneId: nextMapZoneId, mapPoint: nextMapPoint, config: nextConfig });

  const [inserted] = await db.insert(challengeSetItems).values({
    setId: input.setId,
    mapZoneId: nextMapZoneId,
    title: input.title,
    description: input.description,
    kind: input.kind ?? 'text',
    config: buildPersistedConfig(nextConfig, nextMapZoneId, nextMapPoint),
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
  const challengeSet = await getChallengeSetByIdOrThrow(db, existing.setId);
  const nextMapZoneId = input.mapZoneId === undefined ? existing.mapZoneId : input.mapZoneId;
  const nextMapPoint = input.mapPoint === undefined ? existing.mapPoint : input.mapPoint;
  const nextConfig = input.config ?? existing.config;

  assertPlacementMatchesSet(challengeSet.locationMode, nextMapZoneId, nextMapPoint);
  assertBonusLimit(input.config);
  await assertAreaIsValid(db, challengeSet.locationMode, nextConfig, nextMapZoneId, nextMapPoint);
  const nextMetadata = await resolveItemMap(db, challengeSet, input.metadata ?? existing.metadata, { mapZoneId: nextMapZoneId, mapPoint: nextMapPoint, config: nextConfig });

  await db.update(challengeSetItems).set({
    mapZoneId: nextMapZoneId,
    title: input.title ?? existing.title,
    description: input.description ?? existing.description,
    kind: input.kind ?? existing.kind,
    config: buildPersistedConfig(nextConfig, nextMapZoneId, nextMapPoint),
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
  modeKey: string = 'territory',
): Promise<number> {
  const existingRuntimeChallenges = await db.select({ id: challenges.id }).from(challenges).where(eq(challenges.gameId, gameId)).limit(1);
  if (existingRuntimeChallenges.length > 0) {
    return 0;
  }

  const challengeSet = await getChallengeSetByIdOrThrow(db, challengeSetId);
  const items = await listChallengeSetItems(db, challengeSetId);
  if (items.length === 0) {
    return 0;
  }
  if (items.some((item) => !isPlacementAllowedInSet(challengeSet.locationMode, getLocationMode(item)))) {
    throw new AppError(errorCodes.validationError, { message: 'Every challenge item must match its challenge set placement mode.' });
  }
  if (modeKey === 'point_challenge' && challengeSet.locationMode !== 'point') {
    throw new AppError(errorCodes.validationError, { message: 'Challenge Hunt games require a point-linked challenge set.' });
  }

  const shuffledItems = shuffleChallengeSetItems(items);

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

  for (const [runtimeSortOrder, item] of shuffledItems.entries()) {
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
        portable: !item.mapZoneId && !item.mapPoint && !getChallengeArea(item.config),
        location_mode: getChallengeArea(item.config) ? 'area' : getLocationMode(item),
        source_challenge_set_id: challengeSetId,
        source_challenge_set_item_id: item.id,
        source_map_zone_id: item.mapZoneId,
        ...(item.mapPoint ? { source_map_point: item.mapPoint } : {}),
        ...(item.metadata && Object.keys(item.metadata).length > 0 ? { source_metadata: item.metadata } : {}),
      },
      completionMode: item.completionMode,
      scoring: item.scoring,
      difficulty: item.difficulty,
      sortOrder: runtimeSortOrder,
      isDeckActive: false,
      status: 'available',
    }).returning({ id: challenges.id });

    insertedChallengeIds.push(insertedChallenge.id);
  }

  // Pins, areas and judged challenges are open all game; only the rest are dealt from the deck.
  const isAlwaysActive = (item: ChallengeSetItem) => Boolean(item.mapPoint) || Boolean(getChallengeArea(item.config)) || isJudgedChallengeConfig(item.config);
  const pointChallengeIds = shuffledItems
    .map((item, index) => isAlwaysActive(item) ? insertedChallengeIds[index] : null)
    .filter((id): id is string => Boolean(id));
  const deckChallengeIds = shuffledItems
    .map((item, index) => isAlwaysActive(item) ? null : insertedChallengeIds[index])
    .filter((id): id is string => Boolean(id))
    .slice(0, Math.max(1, activeChallengeCount));
  const initialActiveIds = [...new Set([...pointChallengeIds, ...deckChallengeIds])];
  if (initialActiveIds.length > 0) {
    await db.update(challenges).set({
      isDeckActive: true,
      updatedAt: new Date(),
    }).where(inArray(challenges.id, initialActiveIds));
  }

  return items.length;
}

function shuffleChallengeSetItems(items: ChallengeSetItem[]): ChallengeSetItem[] {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex]!;
    shuffled[swapIndex] = current!;
  }

  return shuffled;
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

async function assertAreaIsValid(db: DatabaseClient, setMode: 'portable' | 'zone' | 'point', config: JsonObject, mapZoneId: string | null, mapPoint: GeoJsonPoint | null): Promise<void> {
  if (config.area === undefined || config.area === null) return;
  if (!isAreaGeometry(config.area)) throw new AppError(errorCodes.validationError, { message: 'The challenge area must be a drawn polygon.' });
  if (setMode !== 'point') throw new AppError(errorCodes.validationError, { message: 'Challenge areas are only available in point-linked sets.' });
  if (mapZoneId || mapPoint) throw new AppError(errorCodes.validationError, { message: 'Choose either a pinned point or an area, not both.' });
  const result = await db.execute<{ valid: boolean }>(sql`SELECT ST_IsValid(ST_GeomFromGeoJSON(${JSON.stringify(config.area)})) AS valid`);
  if (!result.rows[0]?.valid) throw new AppError(errorCodes.validationError, { message: 'The challenge area crosses itself. Redraw it without overlapping edges.' });
}

function assertBonusLimit(config: JsonObject | undefined): void {
  const bonuses = config?.bonuses;
  if (Array.isArray(bonuses) && bonuses.length > MAX_CHALLENGE_BONUSES) {
    throw new AppError(errorCodes.validationError, { message: 'A challenge can have at most ' + MAX_CHALLENGE_BONUSES + ' bonus tasks.' });
  }
}

// Point-linked sets mix pinned items with "anywhere" items that have no placement.
function isPlacementAllowedInSet(setMode: 'portable' | 'zone' | 'point', itemMode: 'portable' | 'zone' | 'point'): boolean {
  return setMode === 'point' ? itemMode !== 'zone' : itemMode === setMode;
}

function assertPlacementMatchesSet(mode: 'portable' | 'zone' | 'point', mapZoneId: string | null, mapPoint: GeoJsonPoint | null): void {
  if (mapZoneId && mapPoint) return; // assertPlacementIsValid reports this case.
  if (!isPlacementAllowedInSet(mode, getLocationMode({ mapZoneId, mapPoint }))) throw new AppError(errorCodes.validationError, { message: mode === 'portable' ? 'Portable challenge sets cannot contain placed items.' : mode === 'zone' ? 'Every item in a zone-linked set requires a source zone.' : 'Point-linked sets accept pinned points or anywhere challenges, not zones.' });
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

// Pins, areas and zones belong to the set's map. A set without a map takes the map of its first
// placed challenge. Returns the item metadata with sourceMapId set for placed items.
async function resolveItemMap(
  db: DatabaseClient,
  challengeSet: ChallengeSet,
  metadata: JsonObject,
  item: { mapZoneId: string | null; mapPoint: GeoJsonPoint | null; config: JsonObject },
): Promise<JsonObject> {
  const isPlaced = Boolean(item.mapZoneId || item.mapPoint || getChallengeArea(item.config));
  if (!isPlaced) return metadata;

  let itemMapId = getSourceMapId(metadata);
  if (item.mapZoneId) {
    const [zone] = await db.select({ mapId: mapZones.mapId }).from(mapZones).where(eq(mapZones.id, item.mapZoneId)).limit(1);
    if (zone && !itemMapId) itemMapId = zone.mapId;
  }
  const mapId = challengeSet.mapId ?? itemMapId;
  if (challengeSet.mapId && itemMapId && itemMapId !== challengeSet.mapId) {
    throw new AppError(errorCodes.validationError, { message: 'This challenge is placed on a different map from its set. Place it on the set\'s map.' });
  }
  if (!mapId) {
    throw new AppError(errorCodes.validationError, { message: 'Choose a map for this set before placing challenges on it.' });
  }

  await assertPlacementIsValid(db, { mapZoneId: item.mapZoneId, mapPoint: item.mapPoint, sourceMapId: mapId });
  if (!challengeSet.mapId) {
    await db.update(challengeSets).set({ mapId, updatedAt: new Date() }).where(eq(challengeSets.id, challengeSet.id));
  }
  return { ...metadata, sourceMapId: mapId };
}

// A set's placed challenges sit on its map, so the map can only change once none are on another one.
async function assertSetCanMoveToMap(db: DatabaseClient, challengeSetId: string, mapId: string | null): Promise<void> {
  if (mapId) await assertMapExists(db, mapId);
  const items = await listChallengeSetItems(db, challengeSetId);
  const placed = items.filter((item) => item.mapZoneId || item.mapPoint || getChallengeArea(item.config));
  if (placed.length === 0) return;
  const zoneMapIds = new Map<string, string>();
  const zoneIds = placed.map((item) => item.mapZoneId).filter((id): id is string => Boolean(id));
  if (zoneIds.length) {
    for (const row of await db.select({ id: mapZones.id, mapId: mapZones.mapId }).from(mapZones).where(inArray(mapZones.id, zoneIds))) zoneMapIds.set(row.id, row.mapId);
  }
  const offMap = placed.filter((item) => (item.mapZoneId ? zoneMapIds.get(item.mapZoneId) : getSourceMapId(item.metadata)) !== mapId);
  if (offMap.length > 0) {
    throw new AppError(errorCodes.validationError, {
      message: mapId
        ? offMap.length + ' challenge' + (offMap.length === 1 ? ' is' : 's are') + ' placed on another map. Remove or re-place them before changing the set\'s map.'
        : 'This set has challenges placed on its map, so it needs a map. Remove or switch them to "anywhere" first.',
    });
  }
}

async function assertMapExists(db: DatabaseClient, mapId: string): Promise<void> {
  const [row] = await db.select({ id: maps.id }).from(maps).where(eq(maps.id, mapId)).limit(1);
  if (!row) throw new AppError(errorCodes.validationError, { message: 'Map not found.' });
}

// Games can only use a set written for their map, or a generic set.
export async function assertChallengeSetFitsMap(db: DatabaseClient, challengeSetId: string, mapId: string | null): Promise<void> {
  const challengeSet = await getChallengeSetByIdOrThrow(db, challengeSetId);
  if (!challengeSet.mapId || challengeSet.mapId === mapId) return;
  const [row] = await db.select({ name: maps.name }).from(maps).where(eq(maps.id, challengeSet.mapId)).limit(1);
  throw new AppError(errorCodes.validationError, { message: '"' + challengeSet.name + '" is written for the ' + (row?.name ?? 'another') + ' map. Pick that map or a different challenge set.' });
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

function getSetLocationMode(metadata: JsonObject): 'portable' | 'zone' | 'point' {
  const mode = metadata.locationMode;
  return mode === 'zone' || mode === 'point' ? mode : 'portable';
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
  mapId: challengeSets.mapId,
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
    locationMode: getSetLocationMode(row.metadata),
    id: row.id,
    name: row.name,
    description: row.description,
    mapId: row.mapId,
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
