import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { GeoJsonGeometry, GeoJsonPoint, JsonObject, MapDefinition, MapZone } from '@city-game/shared';
import { errorCodes } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { mapZones, maps, zones } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

interface MapRow {
  id: string;
  name: string;
  city: string | null;
  centerLat: string;
  centerLng: string;
  defaultZoom: number;
  boundary: MapDefinition['boundary'];
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

interface MapZoneRow {
  id: string;
  mapId: string;
  name: string;
  geometry: GeoJsonGeometry;
  centroid: GeoJsonPoint | null;
  pointValue: number;
  claimRadiusMeters: number | null;
  maxGpsErrorMeters: number | null;
  isDisabled: boolean;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface MapInput {
  name: string;
  city?: string | null;
  centerLat: number;
  centerLng: number;
  defaultZoom: number;
  boundary?: MapDefinition['boundary'] | null;
  metadata?: JsonObject;
}

export interface MapUpdateInput {
  name?: string;
  city?: string | null;
  centerLat?: number;
  centerLng?: number;
  defaultZoom?: number;
  boundary?: MapDefinition['boundary'] | null;
  metadata?: JsonObject;
}

export interface MapZoneInput {
  mapId: string;
  name: string;
  geometry: GeoJsonGeometry;
  pointValue?: number;
  claimRadiusMeters?: number | null;
  maxGpsErrorMeters?: number | null;
  isDisabled?: boolean;
  metadata?: JsonObject;
}

export interface MapZoneUpdateInput {
  name?: string;
  geometry?: GeoJsonGeometry;
  pointValue?: number;
  claimRadiusMeters?: number | null;
  maxGpsErrorMeters?: number | null;
  isDisabled?: boolean;
  metadata?: JsonObject;
}

export async function listMaps(db: DatabaseClient): Promise<MapDefinition[]> {
  const rows = await db.select(mapSelectFields).from(maps).orderBy(asc(maps.createdAt));
  return rows.map((row) => serializeMapRow(row as MapRow));
}

export async function getMapById(db: DatabaseClient, mapId: string): Promise<MapDefinition | null> {
  const [row] = await db.select(mapSelectFields).from(maps).where(eq(maps.id, mapId)).limit(1);
  return row ? serializeMapRow(row as MapRow) : null;
}

export async function getMapByIdOrThrow(db: DatabaseClient, mapId: string): Promise<MapDefinition> {
  const map = await getMapById(db, mapId);
  if (!map) {
    throw new AppError(errorCodes.mapNotFound);
  }
  return map;
}

export async function createMap(db: DatabaseClient, input: MapInput): Promise<MapDefinition> {
  const [inserted] = await db.insert(maps).values({
    name: input.name,
    city: input.city ?? null,
    centerLat: input.centerLat.toString(),
    centerLng: input.centerLng.toString(),
    defaultZoom: input.defaultZoom,
    boundary: input.boundary ? buildGeometrySql(input.boundary) : null,
    metadata: input.metadata ?? {},
  }).returning({ id: maps.id });

  return getMapByIdOrThrow(db, inserted.id);
}

export async function updateMap(db: DatabaseClient, mapId: string, input: MapUpdateInput): Promise<MapDefinition> {
  const existing = await getMapByIdOrThrow(db, mapId);

  await db.update(maps).set({
    name: input.name ?? existing.name,
    city: input.city === undefined ? existing.city : input.city,
    centerLat: String(input.centerLat ?? existing.centerLat),
    centerLng: String(input.centerLng ?? existing.centerLng),
    defaultZoom: input.defaultZoom ?? existing.defaultZoom,
    boundary: input.boundary === undefined
      ? (existing.boundary ? buildGeometrySql(existing.boundary) : null)
      : (input.boundary ? buildGeometrySql(input.boundary) : null),
    metadata: input.metadata ?? existing.metadata,
    updatedAt: new Date(),
  }).where(eq(maps.id, mapId));

  return getMapByIdOrThrow(db, mapId);
}

export async function listMapZones(db: DatabaseClient, mapId: string): Promise<MapZone[]> {
  const rows = await db.select(mapZoneSelectFields).from(mapZones).where(eq(mapZones.mapId, mapId)).orderBy(asc(mapZones.createdAt));
  return rows.map((row) => serializeMapZoneRow(row as MapZoneRow));
}

export async function getMapZoneById(db: DatabaseClient, mapZoneId: string): Promise<MapZone | null> {
  const [row] = await db.select(mapZoneSelectFields).from(mapZones).where(eq(mapZones.id, mapZoneId)).limit(1);
  return row ? serializeMapZoneRow(row as MapZoneRow) : null;
}

export async function getMapZoneByIdOrThrow(db: DatabaseClient, mapZoneId: string): Promise<MapZone> {
  const zone = await getMapZoneById(db, mapZoneId);
  if (!zone) {
    throw new AppError(errorCodes.validationError, { message: 'Map zone not found.' });
  }
  return zone;
}

export async function createMapZone(db: DatabaseClient, input: MapZoneInput): Promise<MapZone> {
  await getMapByIdOrThrow(db, input.mapId);
  await validateGeometry(db, input.geometry);

  const [inserted] = await db.insert(mapZones).values({
    mapId: input.mapId,
    name: input.name,
    geometry: buildGeometrySql(input.geometry),
    centroid: buildCentroidSql(input.geometry),
    pointValue: input.pointValue ?? 1,
    claimRadiusMeters: input.claimRadiusMeters ?? null,
    maxGpsErrorMeters: input.maxGpsErrorMeters ?? null,
    isDisabled: input.isDisabled ?? false,
    metadata: input.metadata ?? {},
  }).returning({ id: mapZones.id });

  return getMapZoneByIdOrThrow(db, inserted.id);
}

export async function updateMapZone(db: DatabaseClient, mapZoneId: string, input: MapZoneUpdateInput): Promise<MapZone> {
  const existing = await getMapZoneByIdOrThrow(db, mapZoneId);
  if (input.geometry) {
    await validateGeometry(db, input.geometry);
  }

  const updateValues: Record<string, unknown> = {
    name: input.name ?? existing.name,
    pointValue: input.pointValue ?? existing.pointValue,
    claimRadiusMeters: input.claimRadiusMeters === undefined ? existing.claimRadiusMeters : input.claimRadiusMeters,
    maxGpsErrorMeters: input.maxGpsErrorMeters === undefined ? existing.maxGpsErrorMeters : input.maxGpsErrorMeters,
    isDisabled: input.isDisabled ?? existing.isDisabled,
    metadata: input.metadata ?? existing.metadata,
    updatedAt: new Date(),
  };

  if (input.geometry) {
    updateValues.geometry = buildGeometrySql(input.geometry);
    updateValues.centroid = buildCentroidSql(input.geometry);
  }

  await db.update(mapZones).set(updateValues).where(eq(mapZones.id, mapZoneId));
  return getMapZoneByIdOrThrow(db, mapZoneId);
}

export async function deleteMapZoneById(db: DatabaseClient, mapZoneId: string): Promise<boolean> {
  const [deleted] = await db.delete(mapZones).where(eq(mapZones.id, mapZoneId)).returning({ id: mapZones.id });
  return Boolean(deleted);
}

export async function importMapZones(
  db: DatabaseClient,
  mapId: string,
  features: Array<{
    geometry: GeoJsonGeometry;
    properties?: {
      name?: string;
      pointValue?: number;
      claimRadiusMeters?: number | null;
      maxGpsErrorMeters?: number | null;
      isDisabled?: boolean;
      metadata?: JsonObject;
    };
  }>,
): Promise<MapZone[]> {
  const created: MapZone[] = [];

  for (const [index, feature] of features.entries()) {
    created.push(await createMapZone(db, {
      mapId,
      name: feature.properties?.name?.trim() || ('Imported Zone ' + (index + 1)),
      geometry: feature.geometry,
      pointValue: feature.properties?.pointValue ?? 1,
      claimRadiusMeters: feature.properties?.claimRadiusMeters ?? null,
      maxGpsErrorMeters: feature.properties?.maxGpsErrorMeters ?? null,
      isDisabled: feature.properties?.isDisabled ?? false,
      metadata: feature.properties?.metadata ?? {},
    }));
  }

  return created;
}

export async function splitMapZoneById(
  db: DatabaseClient,
  mapZoneId: string,
  options?: { splitLine?: GeoJsonGeometry | null },
): Promise<[MapZone, MapZone]> {
  try {
    const zone = await getMapZoneByIdOrThrow(db, mapZoneId);
    const splitLine = options?.splitLine ?? null;

    const cutterCte = splitLine
      ? sql`cutter AS (
          SELECT ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(splitLine)}::json), 4326) AS geometry
        )`
      : sql`cutter AS (
          SELECT CASE
            WHEN (xmax - xmin) >= (ymax - ymin)
              THEN ST_SetSRID(ST_MakeLine(
                ST_MakePoint((xmin + xmax) / 2.0, ymin - 1.0),
                ST_MakePoint((xmin + xmax) / 2.0, ymax + 1.0)
              ), 4326)
            ELSE ST_SetSRID(ST_MakeLine(
              ST_MakePoint(xmin - 1.0, (ymin + ymax) / 2.0),
              ST_MakePoint(xmax + 1.0, (ymin + ymax) / 2.0)
            ), 4326)
          END AS geometry
          FROM bounds
        )`;

    const result = await db.execute<{
    firstGeometry: GeoJsonGeometry | null;
    secondGeometry: GeoJsonGeometry | null;
  }>(sql`
    WITH target AS (
      SELECT ${mapZones.geometry} AS geometry
      FROM ${mapZones}
      WHERE ${mapZones.id} = ${mapZoneId}
    ),
    bounds AS (
      SELECT
        ST_XMin(geometry) AS xmin,
        ST_XMax(geometry) AS xmax,
        ST_YMin(geometry) AS ymin,
        ST_YMax(geometry) AS ymax,
        geometry
      FROM target
    ),
    ${cutterCte},
    split_collection AS (
      SELECT ST_CollectionExtract(ST_Split(bounds.geometry, cutter.geometry), 3) AS geometry
      FROM bounds, cutter
    ),
    dumped AS (
      SELECT
        row_number() OVER (ORDER BY ST_Area((dumped_part).geom) DESC) AS part_index,
        (dumped_part).geom AS geometry
      FROM (
        SELECT ST_Dump(geometry) AS dumped_part
        FROM split_collection
      ) parts
    ),
    aggregated AS (
      SELECT
        (
          SELECT ST_AsGeoJSON(geometry)::json
          FROM dumped
          WHERE part_index = 1
          LIMIT 1
        ) AS "firstGeometry",
        (
          SELECT CASE
            WHEN COUNT(*) >= 1 THEN ST_AsGeoJSON(ST_UnaryUnion(ST_Collect(geometry)))::json
            ELSE NULL
          END
          FROM dumped
          WHERE part_index >= 2
        ) AS "secondGeometry"
    )
    SELECT "firstGeometry", "secondGeometry"
    FROM aggregated
  `);

  const firstGeometry = result.rows[0]?.firstGeometry ?? null;
  const secondGeometry = result.rows[0]?.secondGeometry ?? null;

  if (!firstGeometry || !secondGeometry) {
    throw new AppError(errorCodes.validationError, {
      message: 'Zone could not be split into two valid polygons.',
    });
  }

  await db.update(mapZones).set({
    geometry: buildGeometrySql(firstGeometry),
    centroid: buildCentroidSql(firstGeometry),
    updatedAt: new Date(),
  }).where(eq(mapZones.id, zone.id));

  const created = await createMapZone(db, {
    mapId: zone.mapId,
    name: zone.name + ' B',
    geometry: secondGeometry,
    pointValue: zone.pointValue,
    claimRadiusMeters: zone.claimRadiusMeters,
    maxGpsErrorMeters: zone.maxGpsErrorMeters,
    isDisabled: zone.isDisabled,
    metadata: zone.metadata,
  });

    const updated = await getMapZoneByIdOrThrow(db, zone.id);
    return [updated, created];
  } catch (error) {
    throw error;
  }
}

export async function mergeMapZonesById(
  db: DatabaseClient,
  zoneIds: [string, string],
  input: { name?: string } = {},
): Promise<MapZone> {
  const [left, right] = await db.select(mapZoneSelectFields)
    .from(mapZones)
    .where(inArray(mapZones.id, zoneIds));

  const zonesToMerge = [left, right].filter(Boolean) as MapZoneRow[];
  if (zonesToMerge.length !== 2) {
    throw new AppError(errorCodes.validationError, { message: 'Two authored zones are required to merge.' });
  }

  const first = serializeMapZoneRow(zonesToMerge[0]);
  const second = serializeMapZoneRow(zonesToMerge[1]);
  if (first.mapId !== second.mapId) {
    throw new AppError(errorCodes.validationError, { message: 'Zones must belong to the same map.' });
  }

  const unionResult = await db.execute<{ geometry: GeoJsonGeometry | null }>(sql`
    SELECT ST_AsGeoJSON(ST_UnaryUnion(ST_Collect(${mapZones.geometry})))::json AS geometry
    FROM ${mapZones}
    WHERE ${mapZones.id} IN (${zoneIds[0]}, ${zoneIds[1]})
  `);

  const geometry = unionResult.rows[0]?.geometry ?? null;
  if (!geometry) {
    throw new AppError(errorCodes.validationError, { message: 'Failed to merge authored zones.' });
  }

  await validateGeometry(db, geometry);

  await db.update(mapZones).set({
    name: input.name?.trim() || first.name,
    geometry: buildGeometrySql(geometry),
    centroid: buildCentroidSql(geometry),
    pointValue: first.pointValue,
    claimRadiusMeters: first.claimRadiusMeters,
    maxGpsErrorMeters: first.maxGpsErrorMeters,
    isDisabled: first.isDisabled && second.isDisabled,
    metadata: first.metadata,
    updatedAt: new Date(),
  }).where(eq(mapZones.id, first.id));

  await db.delete(mapZones).where(eq(mapZones.id, second.id));
  return getMapZoneByIdOrThrow(db, first.id);
}

export async function cloneMapZonesToGame(db: DatabaseClient, mapId: string, gameId: string): Promise<number> {
  const existingRuntimeZones = await db.select({ id: zones.id }).from(zones).where(eq(zones.gameId, gameId)).limit(1);
  if (existingRuntimeZones.length > 0) {
    return 0;
  }

  const templateZones = await listMapZones(db, mapId);
  if (templateZones.length === 0) {
    return 0;
  }

  for (const zone of templateZones) {
    await db.insert(zones).values({
      gameId,
      name: zone.name,
      geometry: buildGeometrySql(zone.geometry),
      centroid: buildCentroidSql(zone.geometry),
      ownerTeamId: null,
      capturedAt: null,
      pointValue: zone.pointValue,
      claimRadiusMeters: zone.claimRadiusMeters,
      maxGpsErrorMeters: zone.maxGpsErrorMeters,
      isDisabled: zone.isDisabled,
      metadata: {
        ...(zone.metadata ?? {}),
        source_map_id: mapId,
        source_map_zone_id: zone.id,
      },
    });
  }

  return templateZones.length;
}

export async function applyMapDefaultsToGame(db: DatabaseClient, mapId: string) {
  const map = await getMapByIdOrThrow(db, mapId);
  return {
    city: map.city,
    centerLat: map.centerLat,
    centerLng: map.centerLng,
    defaultZoom: map.defaultZoom,
    boundary: map.boundary,
  };
}

export async function validateGeometry(db: DatabaseClient, geometry: GeoJsonGeometry): Promise<void> {
  const geometrySql = buildGeometrySql(geometry);
  const result = await db.execute<{ isValid: boolean; reason: string }>(sql`
    SELECT ST_IsValid(${geometrySql}) AS "isValid", ST_IsValidReason(${geometrySql}) AS "reason"
  `);

  if (!result.rows[0]?.isValid) {
    throw new AppError(errorCodes.validationError, {
      message: 'Zone geometry is invalid.',
      details: { reason: result.rows[0]?.reason ?? 'Unknown geometry validation failure.' },
    });
  }
}

function buildGeometrySql(geometry: GeoJsonGeometry) {
  return sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326)::geometry(Geometry,4326)`;
}

function buildCentroidSql(geometry: GeoJsonGeometry) {
  return sql`ST_Centroid(${buildGeometrySql(geometry)})::geometry(Point,4326)`;
}

const mapSelectFields = {
  id: maps.id,
  name: maps.name,
  city: maps.city,
  centerLat: maps.centerLat,
  centerLng: maps.centerLng,
  defaultZoom: maps.defaultZoom,
  boundary: sql<MapDefinition['boundary']>`CASE WHEN ${maps.boundary} IS NULL THEN NULL ELSE ST_AsGeoJSON(${maps.boundary})::json END`,
  metadata: maps.metadata,
  createdAt: maps.createdAt,
  updatedAt: maps.updatedAt,
};

const mapZoneSelectFields = {
  id: mapZones.id,
  mapId: mapZones.mapId,
  name: mapZones.name,
  geometry: sql<GeoJsonGeometry>`ST_AsGeoJSON(${mapZones.geometry})::json`,
  centroid: sql<GeoJsonPoint | null>`CASE WHEN ${mapZones.centroid} IS NULL THEN NULL ELSE ST_AsGeoJSON(${mapZones.centroid})::json END`,
  pointValue: mapZones.pointValue,
  claimRadiusMeters: mapZones.claimRadiusMeters,
  maxGpsErrorMeters: mapZones.maxGpsErrorMeters,
  isDisabled: mapZones.isDisabled,
  metadata: mapZones.metadata,
  createdAt: mapZones.createdAt,
  updatedAt: mapZones.updatedAt,
};

function serializeMapRow(row: MapRow): MapDefinition {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    centerLat: Number(row.centerLat),
    centerLng: Number(row.centerLng),
    defaultZoom: row.defaultZoom,
    boundary: row.boundary,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeMapZoneRow(row: MapZoneRow): MapZone {
  return {
    id: row.id,
    mapId: row.mapId,
    name: row.name,
    geometry: row.geometry,
    centroid: row.centroid,
    pointValue: row.pointValue,
    claimRadiusMeters: row.claimRadiusMeters,
    maxGpsErrorMeters: row.maxGpsErrorMeters,
    isDisabled: row.isDisabled,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
