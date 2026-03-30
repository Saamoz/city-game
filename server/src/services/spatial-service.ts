import { and, asc, eq, sql } from 'drizzle-orm';
import type { GeoJsonPoint, GeoJsonPolygon, JsonObject, Zone } from '@city-game/shared';
import { DEFAULT_GPS_BUFFER_METERS, errorCodes } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { teams, zones } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

interface ZoneRow {
  id: string;
  gameId: string;
  name: string;
  geometry: GeoJsonPolygon;
  centroid: GeoJsonPoint | null;
  ownerTeamId: string | null;
  capturedAt: Date | null;
  pointValue: number;
  claimRadiusMeters: number | null;
  maxGpsErrorMeters: number | null;
  isDisabled: boolean;
  metadata: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface ZoneInput {
  gameId: string;
  name: string;
  geometry: GeoJsonPolygon;
  ownerTeamId?: string | null;
  pointValue?: number;
  claimRadiusMeters?: number | null;
  maxGpsErrorMeters?: number | null;
  isDisabled?: boolean;
  metadata?: JsonObject;
}

export interface ZoneUpdateInput {
  name?: string;
  geometry?: GeoJsonPolygon;
  ownerTeamId?: string | null;
  pointValue?: number;
  claimRadiusMeters?: number | null;
  maxGpsErrorMeters?: number | null;
  isDisabled?: boolean;
  metadata?: JsonObject;
}

export interface PointInGameInput {
  gameId: string;
  lat: number;
  lng: number;
  includeDisabled?: boolean;
  bufferMeters?: number;
}

export interface PointNearZoneInput {
  zoneId: string;
  lat: number;
  lng: number;
  includeDisabled?: boolean;
  bufferMeters?: number;
}

export async function createZone(db: DatabaseClient, input: ZoneInput): Promise<Zone> {
  await validateZoneGeometry(db, input.geometry);
  await assertOwnerTeamInGame(db, input.gameId, input.ownerTeamId ?? null);

  const geometrySql = buildPolygonGeometrySql(input.geometry);
  const centroidSql = buildCentroidSql(input.geometry);

  const [inserted] = await db
    .insert(zones)
    .values({
      gameId: input.gameId,
      name: input.name,
      geometry: geometrySql,
      centroid: centroidSql,
      ownerTeamId: input.ownerTeamId ?? null,
      pointValue: input.pointValue ?? 1,
      claimRadiusMeters: input.claimRadiusMeters ?? null,
      maxGpsErrorMeters: input.maxGpsErrorMeters ?? null,
      isDisabled: input.isDisabled ?? false,
      metadata: input.metadata ?? {},
    })
    .returning({ id: zones.id });

  return getZoneByIdOrThrow(db, inserted.id);
}

export async function updateZone(db: DatabaseClient, zoneId: string, input: ZoneUpdateInput): Promise<Zone> {
  const existingZone = await getZoneByIdOrThrow(db, zoneId);
  await assertOwnerTeamInGame(db, existingZone.gameId, input.ownerTeamId ?? existingZone.ownerTeamId);

  if (input.geometry) {
    await validateZoneGeometry(db, input.geometry);
  }

  const updateValues: Record<string, unknown> = {
    name: input.name ?? existingZone.name,
    ownerTeamId: input.ownerTeamId === undefined ? existingZone.ownerTeamId : input.ownerTeamId,
    pointValue: input.pointValue ?? existingZone.pointValue,
    claimRadiusMeters:
      input.claimRadiusMeters === undefined ? existingZone.claimRadiusMeters : input.claimRadiusMeters,
    maxGpsErrorMeters:
      input.maxGpsErrorMeters === undefined ? existingZone.maxGpsErrorMeters : input.maxGpsErrorMeters,
    isDisabled: input.isDisabled ?? existingZone.isDisabled,
    metadata: input.metadata ?? existingZone.metadata,
    updatedAt: new Date(),
  };

  if (input.geometry) {
    updateValues.geometry = buildPolygonGeometrySql(input.geometry);
    updateValues.centroid = buildCentroidSql(input.geometry);
  }

  await db.update(zones).set(updateValues).where(eq(zones.id, zoneId));
  return getZoneByIdOrThrow(db, zoneId);
}

export async function listZonesByGame(db: DatabaseClient, gameId: string): Promise<Zone[]> {
  const rows = await db
    .select(zoneSelectFields)
    .from(zones)
    .where(eq(zones.gameId, gameId))
    .orderBy(asc(zones.createdAt));

  return rows.map((row) => serializeZoneRow(row as ZoneRow));
}

export async function getZoneById(db: DatabaseClient, zoneId: string): Promise<Zone | null> {
  const [row] = await db.select(zoneSelectFields).from(zones).where(eq(zones.id, zoneId)).limit(1);
  return row ? serializeZoneRow(row as ZoneRow) : null;
}

export async function getZoneByIdOrThrow(db: DatabaseClient, zoneId: string): Promise<Zone> {
  const zone = await getZoneById(db, zoneId);

  if (!zone) {
    throw new AppError(errorCodes.validationError, {
      message: 'Zone not found.',
    });
  }

  return zone;
}

export async function deleteZoneById(db: DatabaseClient, zoneId: string): Promise<boolean> {
  const [deleted] = await db.delete(zones).where(eq(zones.id, zoneId)).returning({ id: zones.id });
  return Boolean(deleted);
}

export async function findContainingZones(db: DatabaseClient, input: PointInGameInput): Promise<Zone[]> {
  const pointSql = buildPointSql(input.lng, input.lat);
  const bufferOverrideSql =
    input.bufferMeters === undefined ? sql`NULL::integer` : sql`${input.bufferMeters}::integer`;

  const rows = await db
    .select(zoneSelectFields)
    .from(zones)
    .where(
      and(
        eq(zones.gameId, input.gameId),
        input.includeDisabled ? undefined : eq(zones.isDisabled, false),
        sql`ST_Covers(
          ST_Buffer(
            ${zones.geometry}::geography,
            COALESCE(${bufferOverrideSql}, ${zones.claimRadiusMeters}, ${DEFAULT_GPS_BUFFER_METERS})
          )::geometry,
          ${pointSql}
        )`,
      ),
    )
    .orderBy(asc(zones.createdAt));

  return rows.map((row) => serializeZoneRow(row as ZoneRow));
}

export async function isPointWithinZoneBuffer(db: DatabaseClient, input: PointNearZoneInput): Promise<boolean> {
  const zone = await getZoneById(db, input.zoneId);

  if (!zone) {
    return false;
  }

  if (zone.isDisabled && !input.includeDisabled) {
    return false;
  }

  const pointSql = buildPointSql(input.lng, input.lat);
  const bufferMeters = input.bufferMeters ?? zone.claimRadiusMeters ?? DEFAULT_GPS_BUFFER_METERS;

  const result = await db.execute<{ covered: boolean }>(sql`
    SELECT ST_Covers(
      ST_Buffer(${zones.geometry}::geography, ${bufferMeters})::geometry,
      ${pointSql}
    ) AS "covered"
    FROM ${zones}
    WHERE ${zones.id} = ${input.zoneId}
    LIMIT 1
  `);

  return Boolean(result.rows[0]?.covered);
}

export async function getDistanceToZoneMeters(
  db: DatabaseClient,
  input: Omit<PointNearZoneInput, 'includeDisabled' | 'bufferMeters'>,
): Promise<number | null> {
  const pointSql = buildPointSql(input.lng, input.lat);
  const result = await db.execute<{ distanceMeters: number }>(sql`
    SELECT ST_Distance(${zones.geometry}::geography, ${pointSql}::geography) AS "distanceMeters"
    FROM ${zones}
    WHERE ${zones.id} = ${input.zoneId}
    LIMIT 1
  `);

  return result.rows[0]?.distanceMeters ?? null;
}

export async function importZones(
  db: DatabaseClient,
  gameId: string,
  features: Array<{
    geometry: GeoJsonPolygon;
    properties?: {
      name?: string;
      ownerTeamId?: string | null;
      pointValue?: number;
      claimRadiusMeters?: number | null;
      maxGpsErrorMeters?: number | null;
      isDisabled?: boolean;
      metadata?: JsonObject;
    };
  }>,
): Promise<Zone[]> {
  return db.transaction(async (tx) => {
    const createdZones: Zone[] = [];

    for (const [index, feature] of features.entries()) {
      const zone = await createZone(tx as unknown as DatabaseClient, {
        gameId,
        name: feature.properties?.name?.trim() || `Imported Zone ${index + 1}`,
        geometry: feature.geometry,
        ownerTeamId: feature.properties?.ownerTeamId ?? null,
        pointValue: feature.properties?.pointValue ?? 1,
        claimRadiusMeters: feature.properties?.claimRadiusMeters ?? null,
        maxGpsErrorMeters: feature.properties?.maxGpsErrorMeters ?? null,
        isDisabled: feature.properties?.isDisabled ?? false,
        metadata: feature.properties?.metadata ?? {},
      });

      createdZones.push(zone);
    }

    return createdZones;
  });
}

export async function validateZoneGeometry(db: DatabaseClient, geometry: GeoJsonPolygon): Promise<void> {
  const geometrySql = buildPolygonGeometrySql(geometry);
  const validationResult = await db.execute<{ isValid: boolean; reason: string }>(sql`
    SELECT
      ST_IsValid(${geometrySql}) AS "isValid",
      ST_IsValidReason(${geometrySql}) AS "reason"
  `);

  if (!validationResult.rows[0]?.isValid) {
    throw new AppError(errorCodes.validationError, {
      message: 'Zone geometry is invalid.',
      details: {
        reason: validationResult.rows[0]?.reason ?? 'Unknown geometry validation failure.',
      },
    });
  }
}

async function assertOwnerTeamInGame(
  db: DatabaseClient,
  gameId: string,
  ownerTeamId: string | null,
): Promise<void> {
  if (!ownerTeamId) {
    return;
  }

  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, ownerTeamId), eq(teams.gameId, gameId)))
    .limit(1);

  if (!team) {
    throw new AppError(errorCodes.teamNotFound);
  }
}

function buildPolygonGeometrySql(geometry: GeoJsonPolygon) {
  return sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326)::geometry(Polygon,4326)`;
}

function buildCentroidSql(geometry: GeoJsonPolygon) {
  return sql`ST_Centroid(${buildPolygonGeometrySql(geometry)})::geometry(Point,4326)`;
}

function buildPointSql(lng: number, lat: number) {
  return sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geometry(Point,4326)`;
}

const zoneSelectFields = {
  id: zones.id,
  gameId: zones.gameId,
  name: zones.name,
  geometry: sql<GeoJsonPolygon>`ST_AsGeoJSON(${zones.geometry})::json`,
  centroid: sql<GeoJsonPoint | null>`CASE WHEN ${zones.centroid} IS NULL THEN NULL ELSE ST_AsGeoJSON(${zones.centroid})::json END`,
  ownerTeamId: zones.ownerTeamId,
  capturedAt: zones.capturedAt,
  pointValue: zones.pointValue,
  claimRadiusMeters: zones.claimRadiusMeters,
  maxGpsErrorMeters: zones.maxGpsErrorMeters,
  isDisabled: zones.isDisabled,
  metadata: zones.metadata,
  createdAt: zones.createdAt,
  updatedAt: zones.updatedAt,
};

function serializeZoneRow(row: ZoneRow): Zone {
  return {
    id: row.id,
    gameId: row.gameId,
    name: row.name,
    geometry: row.geometry,
    centroid: row.centroid,
    ownerTeamId: row.ownerTeamId,
    capturedAt: toIsoString(row.capturedAt),
    pointValue: row.pointValue,
    claimRadiusMeters: row.claimRadiusMeters,
    maxGpsErrorMeters: row.maxGpsErrorMeters,
    isDisabled: row.isDisabled,
    metadata: row.metadata,
    createdAt: toIsoString(row.createdAt)!,
    updatedAt: toIsoString(row.updatedAt)!,
  };
}

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
