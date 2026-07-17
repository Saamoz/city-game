import { asc, eq, inArray, sql } from 'drizzle-orm';
import {
  applyAdjacencyGapFix,
  planAdjacencyGapFixes,
  propagateSharedBoundaryEdit,
  type GeoJsonGeometry,
  type GeoJsonPoint,
  type JsonObject,
  type MapDefinition,
  type MapZone,
} from '@city-game/shared';
import { errorCodes } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { games, mapZones, maps, zones } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { recordZoneEdit, reproOutcomeFromError, type ZoneEditReproUpdate } from '../lib/zone-edit-repro.js';

interface MapRow {
  id: string;
  name: string;
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
  centerLat: number;
  centerLng: number;
  defaultZoom: number;
  boundary?: MapDefinition['boundary'] | null;
  metadata?: JsonObject;
}

export interface MapUpdateInput {
  name?: string;
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

export interface MapZoneUpdateResult {
  zone: MapZone;
  zones: MapZone[];
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

export async function deleteMapById(db: DatabaseClient, mapId: string): Promise<boolean> {
  await getMapByIdOrThrow(db, mapId);

  const linkedGames = await db.select({ id: games.id }).from(games).where(eq(games.mapId, mapId)).limit(1);
  if (linkedGames.length > 0) {
    throw new AppError(errorCodes.validationError, {
      message: 'Map is already assigned to one or more games and cannot be deleted.',
      details: { mapId },
    });
  }

  await db.delete(mapZones).where(eq(mapZones.mapId, mapId));
  const [deleted] = await db.delete(maps).where(eq(maps.id, mapId)).returning({ id: maps.id });
  return Boolean(deleted);
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

/** Standalone create used by the API route — gated so creating on an already-dirty map still works. */
export async function createMapZoneChecked(db: DatabaseClient, input: MapZoneInput): Promise<MapZone> {
  await getMapByIdOrThrow(db, input.mapId);
  return runMapZoneWrite(db, input.mapId, (tx) => createMapZone(tx, input));
}

export async function isMapZonePartitionClean(db: DatabaseClient, mapId: string): Promise<boolean> {
  const result = await db.execute<{ connected: boolean; noOverlaps: boolean }>(sql`
    SELECT
      map_zone_graph_connected(${mapId}::uuid) AS "connected",
      map_zone_partition_has_no_overlaps(${mapId}::uuid) AS "noOverlaps"
  `);
  return Boolean(result.rows[0]?.connected) && Boolean(result.rows[0]?.noOverlaps);
}

export async function updateMapZone(
  db: DatabaseClient,
  mapZoneId: string,
  input: MapZoneUpdateInput,
): Promise<MapZoneUpdateResult> {
  const existingZone = await getMapZoneByIdOrThrow(db, mapZoneId);

  return runMapZoneWrite(db, existingZone.mapId, async (transactionalDb, { enforced }) => {
    const existing = await getMapZoneByIdOrThrow(transactionalDb, mapZoneId);
    const updatedAt = new Date();
    let affectedZoneIds = [mapZoneId];

    if (input.geometry) {
      await validateGeometry(transactionalDb, input.geometry);
      const mapZoneRows = await listMapZones(transactionalDb, existing.mapId);
      const propagation = propagateSharedBoundaryEdit(
        mapZoneId,
        existing.geometry,
        input.geometry,
        mapZoneRows,
      );
      affectedZoneIds = propagation.affectedZoneIds;

      for (const [zoneId, geometry] of Object.entries(propagation.geometries)) {
        await validateGeometry(transactionalDb, geometry);
        await transactionalDb
          .update(mapZones)
          .set({
            geometry: buildGeometrySql(geometry),
            centroid: buildCentroidSql(geometry),
            updatedAt,
          })
          .where(eq(mapZones.id, zoneId));
      }
    }

    await transactionalDb.update(mapZones).set({
      name: input.name ?? existing.name,
      pointValue: input.pointValue ?? existing.pointValue,
      claimRadiusMeters: input.claimRadiusMeters === undefined ? existing.claimRadiusMeters : input.claimRadiusMeters,
      maxGpsErrorMeters: input.maxGpsErrorMeters === undefined ? existing.maxGpsErrorMeters : input.maxGpsErrorMeters,
      isDisabled: input.isDisabled ?? existing.isDisabled,
      metadata: input.metadata ?? existing.metadata,
      updatedAt,
    }).where(eq(mapZones.id, mapZoneId));

    const updatedZones = await listMapZones(transactionalDb, existing.mapId);
    const affectedZones = updatedZones.filter((zone) => affectedZoneIds.includes(zone.id));
    const zone = affectedZones.find((entry) => entry.id === mapZoneId);
    if (!zone) {
      throw new AppError(errorCodes.validationError, { message: 'Updated map zone not found.' });
    }

    if (affectedZoneIds.length > 3) {
      console.warn('[update-map-zone] propagation touched an unusually large number of zones:', {
        mapZoneId, mapId: existing.mapId, affectedZoneCount: affectedZoneIds.length,
      });
    }

    if (enforced && input.geometry) {
      await assertMapPartitionValid(transactionalDb, existing.mapId);
    }

    return {
      zone,
      zones: affectedZones,
    };
  });
}

/**
 * Runs a write to this map's zones with the map-wide partition constraint in
 * the right posture:
 *
 *  - Map currently clean → normal transaction; the deferred
 *    `map_zones_connected` constraint trigger verifies the whole map again at
 *    COMMIT, so a bad edit can never dirty a clean map.
 *  - Map already dirty (pre-existing gaps/overlaps, e.g. imported data or a
 *    cleanup in progress) → the constraint is suspended for this transaction.
 *    Otherwise every operation on the map — including the ones fixing it —
 *    is rejected for problems it didn't cause.
 *
 * Constraint violations surface as friendly validation errors instead of a
 * raw database exception.
 */
async function runMapZoneWrite<T>(
  db: DatabaseClient,
  mapId: string,
  run: (tx: DatabaseClient, options: { enforced: boolean }) => Promise<T>,
): Promise<T> {
  const clean = await isMapZonePartitionClean(db, mapId);
  try {
    if (clean) {
      return await db.transaction((tx) => run(tx as unknown as DatabaseClient, { enforced: true }));
    }
    return await runMapZonePartitionRepair(db, (tx) => run(tx, { enforced: false }));
  } catch (error) {
    throw translatePartitionConstraintError(error);
  }
}

function translatePartitionConstraintError(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { constraint?: string; message?: string; cause?: unknown };
    if (
      candidate.constraint === 'map_zones_connected'
      || (typeof candidate.message === 'string' && candidate.message.includes('connected, non-overlapping partition'))
    ) {
      return new AppError(errorCodes.validationError, {
        message: 'This change would break the map: zones must not overlap, and every zone must share a border with the rest. Nothing was saved.',
        details: { constraint: 'map_zones_connected' },
      });
    }
    current = candidate.cause;
  }
  return error;
}

/**
 * Re-checks the partition inside a transaction and throws a validation error
 * that names the offending zones — far more actionable than the constraint
 * trigger's generic COMMIT-time failure, which can't say what went wrong.
 */
async function assertMapPartitionValid(tx: DatabaseClient, mapId: string): Promise<void> {
  const report = await checkMapZonePartition(tx, mapId);
  if (report.hasNoOverlaps && report.isConnected) return;

  if (!report.hasNoOverlaps) {
    const pairs = report.overlaps
      .slice(0, 3)
      .map((overlap) => `"${overlap.zoneAName}" ↔ "${overlap.zoneBName}" (${Math.round(overlap.overlapAreaSqMeters)} m²)`)
      .join(', ');
    const suffix = report.overlaps.length > 3 ? ` and ${report.overlaps.length - 3} more` : '';
    throw new AppError(errorCodes.validationError, {
      message: `This change would make zones overlap: ${pairs}${suffix}. Nothing was saved.`,
      details: { constraint: 'map_zones_connected' },
    });
  }

  throw new AppError(errorCodes.validationError, {
    message: 'This change would cut a zone off from the rest of the map — every zone must share a border with at least one other. Nothing was saved.',
    details: { constraint: 'map_zones_connected' },
  });
}

export interface MapZoneGeometryUpdate {
  zoneId: string;
  geometry: GeoJsonGeometry;
}

/**
 * Saves a batch of zone geometries atomically. This is the save path for the
 * shared-boundary ("topology") editing session in the admin editor: the
 * client computes the final geometry of every zone touched by an edit (they
 * share boundary nodes, so one drag can reshape several zones), and the whole
 * set is validated and written together — either every zone updates or none.
 */
export async function updateMapZoneGeometries(
  db: DatabaseClient,
  mapId: string,
  updates: MapZoneGeometryUpdate[],
): Promise<MapZone[]> {
  await getMapByIdOrThrow(db, mapId);

  // Snapshot the "before" geometry of every touched zone up front so the repro
  // log (written below, success or failure) is fully self-contained.
  const reproUpdates: ZoneEditReproUpdate[] = [];
  for (const update of updates) {
    const existing = await getMapZoneById(db, update.zoneId);
    reproUpdates.push({
      zoneId: update.zoneId,
      zoneName: existing?.name,
      geometry: update.geometry,
      previousGeometry: existing?.geometry,
    });
  }

  try {
    const result = await runMapZoneWrite(db, mapId, async (tx, { enforced }) => {
      const updatedAt = new Date();

      for (const update of updates) {
        const zone = await getMapZoneByIdOrThrow(tx, update.zoneId);
        if (zone.mapId !== mapId) {
          throw new AppError(errorCodes.validationError, {
            message: `Zone "${zone.name}" does not belong to this map.`,
          });
        }
        await validateGeometry(tx, update.geometry, { id: zone.id, name: zone.name });
        await tx.update(mapZones).set({
          geometry: buildGeometrySql(update.geometry),
          centroid: buildCentroidSql(update.geometry),
          updatedAt,
        }).where(eq(mapZones.id, update.zoneId));
      }

      if (enforced) {
        await assertMapPartitionValid(tx, mapId);
      }

      return listMapZones(tx, mapId);
    });
    recordZoneEdit({ kind: 'geometry-save', mapId, updates: reproUpdates, outcome: { ok: true } });
    return result;
  } catch (error) {
    recordZoneEdit({ kind: 'geometry-save', mapId, updates: reproUpdates, outcome: reproOutcomeFromError(error) });
    throw error;
  }
}

export interface CreateMapZoneCarveResult {
  zone: MapZone;
  zones: MapZone[];
  trimmedZoneIds: string[];
}

/**
 * Creates a zone that "eats into" whatever it overlaps: the new zone keeps
 * its drawn shape, and every existing zone it intersects gives up the shared
 * ground (ST_Difference). Because the neighbours are trimmed with the new
 * zone's exact boundary, the resulting borders are shared precisely — no
 * gaps, no overlaps — which is what makes free-hand drawing over an existing
 * map safe. Refuses to swallow a zone whole.
 */
export async function createMapZoneCarve(db: DatabaseClient, input: MapZoneInput): Promise<CreateMapZoneCarveResult> {
  await getMapByIdOrThrow(db, input.mapId);
  const reproUpdates: ZoneEditReproUpdate[] = [{ zoneId: 'new', zoneName: input.name, geometry: input.geometry }];
  try {
    await validateGeometry(db, input.geometry, { name: input.name });
    const result = await carveMapZoneInner(db, input);
    recordZoneEdit({ kind: 'carve-create', mapId: input.mapId, updates: reproUpdates, outcome: { ok: true } });
    return result;
  } catch (error) {
    recordZoneEdit({ kind: 'carve-create', mapId: input.mapId, updates: reproUpdates, outcome: reproOutcomeFromError(error, { name: input.name }) });
    throw error;
  }
}

async function carveMapZoneInner(db: DatabaseClient, input: MapZoneInput): Promise<CreateMapZoneCarveResult> {
  return runMapZoneWrite(db, input.mapId, async (tx, { enforced }) => {
    const newGeometrySql = buildGeometrySql(input.geometry);
    const overlapping = await tx.execute<{
      id: string;
      name: string;
      remainder: GeoJsonGeometry | null;
      remainderEmpty: boolean | null;
    }>(sql`
      SELECT
        id,
        name,
        ST_AsGeoJSON(ST_CollectionExtract(ST_Difference(geometry, ${newGeometrySql}), 3))::json AS "remainder",
        ST_IsEmpty(ST_CollectionExtract(ST_Difference(geometry, ${newGeometrySql}), 3)) AS "remainderEmpty"
      FROM ${mapZones}
      WHERE map_id = ${input.mapId}
        AND ST_Area(ST_Intersection(geometry, ${newGeometrySql})) > 0.000000000001
    `);

    const swallowed = overlapping.rows.filter((row) => !row.remainder || row.remainderEmpty);
    if (swallowed.length > 0) {
      const names = swallowed.map((row) => `"${row.name}"`).join(', ');
      throw new AppError(errorCodes.validationError, {
        message: `The drawn zone would completely cover ${names}. Delete that zone first, or draw a smaller shape.`,
      });
    }

    const updatedAt = new Date();
    for (const row of overlapping.rows) {
      await validateGeometry(tx, row.remainder as GeoJsonGeometry, { id: row.id, name: row.name });
      await tx.update(mapZones).set({
        geometry: buildGeometrySql(row.remainder as GeoJsonGeometry),
        centroid: buildCentroidSql(row.remainder as GeoJsonGeometry),
        updatedAt,
      }).where(eq(mapZones.id, row.id));
    }

    const zone = await createMapZone(tx, input);

    if (enforced) {
      await assertMapPartitionValid(tx, input.mapId);
    }

    return {
      zone,
      zones: await listMapZones(tx, input.mapId),
      trimmedZoneIds: overlapping.rows.map((row) => row.id),
    };
  });
}

export interface HealMapZoneGapsSkip {
  zoneIds: string[];
  gapMeters: number;
  reason: string;
}

export interface HealMapZoneGapsResult {
  zones: MapZone[];
  healedGapCount: number;
  skippedGapCount: number;
  skippedGaps: HealMapZoneGapsSkip[];
}

/**
 * Runs a zone repair operation with the map-wide partition constraint trigger
 * suspended for the duration of the transaction.
 *
 * `map_zones_connected` is a DEFERRED constraint trigger: at COMMIT it requires
 * the ENTIRE map to be one connected, non-overlapping partition. That's the
 * right guard for normal edits, but it deadlocks *repair* of a map that is
 * already invalid. If a map has pre-existing overlaps and/or gaps (e.g. data
 * imported before the constraint existed), the whole-map check fails globally,
 * so every individual repair write -- trim one overlap, heal one gap -- is
 * rejected at commit even though it strictly improves the map. And you can't
 * reach a clean state incrementally, because each incremental step is itself
 * blocked by the problems it hasn't fixed yet. (Savepoints / SET CONSTRAINTS
 * IMMEDIATE can't escape this: they still evaluate the whole map, which is
 * still globally dirty.)
 *
 * Disabling the trigger inside the repair transaction lets these operations
 * make incremental progress. It is safe here because every repair only ever
 * moves the map toward a valid partition (subtracting overlap area, snapping
 * gap vertices onto a shared point), and each written geometry is still
 * individually validated with ST_IsValid so we never persist self-intersecting
 * garbage. The map may remain globally imperfect between repair steps -- which
 * is exactly the state the admin is working to clean up. The trigger is
 * re-enabled before commit (and, on error, the rollback undoes the disable).
 *
 * NOTE: this only touches `map_zones` / its `map_zones_connected` trigger; the
 * runtime `zones` table and its own constraint are untouched.
 */
async function runMapZonePartitionRepair<T>(
  db: DatabaseClient,
  run: (tx: DatabaseClient) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as DatabaseClient;
    await transactionalDb.execute(sql`ALTER TABLE map_zones DISABLE TRIGGER map_zones_connected`);
    const result = await run(transactionalDb);
    // Only re-enable on the success path. If `run` threw, we never reach here
    // and the transaction rolls back -- which also undoes the DISABLE -- so we
    // avoid issuing DDL against a possibly-aborted transaction.
    await transactionalDb.execute(sql`ALTER TABLE map_zones ENABLE TRIGGER map_zones_connected`);
    return result;
  });
}

export async function healMapZoneGaps(
  db: DatabaseClient,
  mapId: string,
  toleranceMeters: number,
): Promise<HealMapZoneGapsResult> {
  return runMapZonePartitionRepair(db, async (transactionalDb) => {
    await getMapByIdOrThrow(transactionalDb, mapId);
    const mapZoneRows = await listMapZones(transactionalDb, mapId);
    const zoneNameById = new Map(mapZoneRows.map((zone) => [zone.id, zone.name]));
    const fixes = planAdjacencyGapFixes(mapZoneRows, toleranceMeters);

    // With the map-wide constraint suspended by the repair wrapper, the only
    // reason to skip a gap fix is a genuinely invalid resulting SHAPE (e.g. a
    // self-intersecting ring) -- which we still catch per zone with ST_IsValid.
    const currentGeometries = new Map(mapZoneRows.map((zone) => [zone.id, zone.geometry]));
    let healedGapCount = 0;
    let skippedGapCount = 0;
    const skippedGaps: HealMapZoneGapsSkip[] = [];

    for (const fix of fixes) {
      const touchedZoneIds = Array.from(new Set(fix.edits.map((edit) => edit.zoneId)));
      if (touchedZoneIds.length === 0) continue;
      const zoneLabel = fix.gap.zoneIds.map((zoneId) => zoneNameById.get(zoneId) ?? zoneId).join(' <-> ');

      const candidateGeometries = new Map<string, GeoJsonGeometry>();
      for (const zoneId of touchedZoneIds) {
        const base = currentGeometries.get(zoneId);
        if (!base) continue;
        const zoneEdits = fix.edits.filter((edit) => edit.zoneId === zoneId);
        candidateGeometries.set(zoneId, applyAdjacencyGapFix(base, zoneEdits));
      }

      let shapeReason: string | null = null;
      for (const geometry of candidateGeometries.values()) {
        try {
          await validateGeometry(transactionalDb, geometry);
        } catch (error) {
          shapeReason = error instanceof AppError
            ? String((error.details as { reason?: string } | undefined)?.reason ?? error.message)
            : 'unknown shape validation failure';
          break;
        }
      }

      if (shapeReason) {
        skippedGapCount += 1;
        skippedGaps.push({ zoneIds: fix.gap.zoneIds, gapMeters: fix.gap.gapMeters, reason: shapeReason });
        console.warn('[heal-gaps] skipped fix (invalid shape):', { mapId, zones: zoneLabel, gapMeters: fix.gap.gapMeters, reason: shapeReason });
        continue;
      }

      const updatedAt = new Date();
      for (const [zoneId, geometry] of candidateGeometries) {
        await transactionalDb
          .update(mapZones)
          .set({
            geometry: buildGeometrySql(geometry),
            centroid: buildCentroidSql(geometry),
            updatedAt,
          })
          .where(eq(mapZones.id, zoneId));
        currentGeometries.set(zoneId, geometry);
      }
      healedGapCount += 1;
    }

    if (skippedGaps.length > 0) {
      console.warn(`[heal-gaps] map ${mapId}: healed ${healedGapCount}, skipped ${skippedGaps.length} of ${fixes.length} fixes`);
    }

    return {
      zones: await listMapZones(transactionalDb, mapId),
      healedGapCount,
      skippedGapCount,
      skippedGaps,
    };
  });
}

export interface MapZonePartitionOverlap {
  zoneAId: string;
  zoneAName: string;
  zoneBId: string;
  zoneBName: string;
  overlapAreaSqMeters: number;
}

export interface MapZonePartitionReport {
  isConnected: boolean;
  hasNoOverlaps: boolean;
  overlaps: MapZonePartitionOverlap[];
}

/**
 * Reports whether this map currently satisfies the same connectivity/overlap
 * rule the map_zones_connected constraint enforces, and -- unlike that
 * constraint's boolean pass/fail -- lists which specific zone pairs actually
 * overlap. Gap healing only fixes near-miss vertices; a real overlap (e.g.
 * from data imported before this constraint existed) is a different problem
 * that blocks every write to this map's zones, including gap healing, until
 * it's resolved by hand.
 */
export async function checkMapZonePartition(db: DatabaseClient, mapId: string): Promise<MapZonePartitionReport> {
  await getMapByIdOrThrow(db, mapId);

  const statusResult = await db.execute<{ connected: boolean; noOverlaps: boolean }>(sql`
    SELECT
      map_zone_graph_connected(${mapId}::uuid) AS "connected",
      map_zone_partition_has_no_overlaps(${mapId}::uuid) AS "noOverlaps"
  `);

  const overlapsResult = await db.execute<{
    zoneAId: string;
    zoneAName: string;
    zoneBId: string;
    zoneBName: string;
    areaSqMeters: number | null;
  }>(sql`
    SELECT
      a.id AS "zoneAId", a.name AS "zoneAName",
      b.id AS "zoneBId", b.name AS "zoneBName",
      ST_Area(ST_Intersection(a.geometry, b.geometry)::geography) AS "areaSqMeters"
    FROM ${mapZones} a
    JOIN ${mapZones} b ON a.map_id = b.map_id AND a.id < b.id
    WHERE a.map_id = ${mapId}
      AND ST_Area(ST_Intersection(a.geometry, b.geometry)) > 0.000000000001
    ORDER BY "areaSqMeters" DESC NULLS LAST
  `);

  return {
    isConnected: Boolean(statusResult.rows[0]?.connected),
    hasNoOverlaps: Boolean(statusResult.rows[0]?.noOverlaps),
    overlaps: overlapsResult.rows.map((row) => ({
      zoneAId: row.zoneAId,
      zoneAName: row.zoneAName,
      zoneBId: row.zoneBId,
      zoneBName: row.zoneBName,
      overlapAreaSqMeters: Number(row.areaSqMeters ?? 0),
    })),
  };
}

export interface ResolveMapZoneOverlapInput {
  trimZoneId: string;
  keepZoneId: string;
}

export interface ResolveMapZoneOverlapResult {
  zones: MapZone[];
}

/**
 * Resolves a real zone-vs-zone overlap by subtracting the "keep" zone's
 * shape from the "trim" zone's -- the trim zone gives up whatever ground it
 * shared with the other. Unlike a gap fix, there's no single correct answer
 * here (the disputed area has to go to one side or the other), so this is
 * an explicit, user-chosen action rather than something automatic.
 */
export async function resolveMapZoneOverlap(
  db: DatabaseClient,
  mapId: string,
  input: ResolveMapZoneOverlapInput,
): Promise<ResolveMapZoneOverlapResult> {
  return runMapZonePartitionRepair(db, async (transactionalDb) => {
    await getMapByIdOrThrow(transactionalDb, mapId);
    const trimZone = await getMapZoneByIdOrThrow(transactionalDb, input.trimZoneId);
    const keepZone = await getMapZoneByIdOrThrow(transactionalDb, input.keepZoneId);

    if (trimZone.mapId !== mapId || keepZone.mapId !== mapId) {
      throw new AppError(errorCodes.validationError, { message: 'Both zones must belong to this map.' });
    }
    if (trimZone.id === keepZone.id) {
      throw new AppError(errorCodes.validationError, { message: 'Cannot resolve an overlap between a zone and itself.' });
    }

    console.log('[resolve-overlap] request:', {
      mapId, trimZoneId: trimZone.id, trimZoneName: trimZone.name, keepZoneId: keepZone.id, keepZoneName: keepZone.name,
    });

    const trimGeometrySql = buildGeometrySql(trimZone.geometry);
    const keepGeometrySql = buildGeometrySql(keepZone.geometry);

    // ST_Difference on two polygons can return a GeometryCollection with
    // degenerate line/point artifacts mixed in alongside the real polygonal
    // result (the same reason ST_Split's result gets run through
    // ST_CollectionExtract elsewhere in this file). Extracting just the
    // polygon parts (type 3) keeps the written geometry a clean
    // Polygon/MultiPolygon instead of something ST_IsValid or the client's
    // renderer doesn't expect.
    const differenceResult = await transactionalDb.execute<{
      geometry: GeoJsonGeometry | null;
      isEmpty: boolean | null;
      geometryType: string | null;
      areaBefore: number | null;
      areaAfter: number | null;
    }>(sql`
      WITH difference AS (
        SELECT ST_CollectionExtract(ST_Difference(${trimGeometrySql}, ${keepGeometrySql}), 3) AS geometry
      )
      SELECT
        ST_AsGeoJSON(geometry)::json AS "geometry",
        ST_IsEmpty(geometry) AS "isEmpty",
        GeometryType(geometry) AS "geometryType",
        ST_Area(${trimGeometrySql}::geography) AS "areaBefore",
        ST_Area(geometry::geography) AS "areaAfter"
      FROM difference
    `);

    const row = differenceResult.rows[0];
    console.log('[resolve-overlap] ST_Difference result:', {
      hasGeometry: Boolean(row?.geometry),
      isEmpty: row?.isEmpty,
      geometryType: row?.geometryType,
      areaBeforeSqM: row?.areaBefore,
      areaAfterSqM: row?.areaAfter,
    });

    const geometry = row?.geometry ?? null;
    if (!geometry || row?.isEmpty) {
      console.warn('[resolve-overlap] rejected: empty or missing difference result', { mapId, trimZoneId: trimZone.id, keepZoneId: keepZone.id });
      throw new AppError(errorCodes.validationError, {
        message: `Trimming "${trimZone.name}" against "${keepZone.name}" would remove the entire zone -- it may sit fully inside the other. Try trimming "${keepZone.name}" instead, or fix this by hand with Edit Vertices.`,
      });
    }

    await validateGeometry(transactionalDb, geometry);

    await transactionalDb
      .update(mapZones)
      .set({
        geometry: buildGeometrySql(geometry),
        centroid: buildCentroidSql(geometry),
        updatedAt: new Date(),
      })
      .where(eq(mapZones.id, trimZone.id));

    console.log('[resolve-overlap] applied trim', { mapId, trimZoneId: trimZone.id, keepZoneId: keepZone.id });

    return {
      zones: await listMapZones(transactionalDb, mapId),
    };
  });
}

export async function deleteMapZoneById(db: DatabaseClient, mapZoneId: string): Promise<boolean> {
  const zone = await getMapZoneById(db, mapZoneId);
  if (!zone) return false;

  return runMapZoneWrite(db, zone.mapId, async (tx) => {
    const [deleted] = await tx.delete(mapZones).where(eq(mapZones.id, mapZoneId)).returning({ id: mapZones.id });
    return Boolean(deleted);
  });
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
  return runMapZoneWrite(db, mapId, async (transactionalDb) => {
    const created: MapZone[] = [];

    for (const [index, feature] of features.entries()) {
      created.push(await createMapZone(transactionalDb, {
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
  });
}

export async function splitMapZoneById(
  db: DatabaseClient,
  mapZoneId: string,
  options?: { splitLine?: GeoJsonGeometry | null },
): Promise<[MapZone, MapZone]> {
  const zone = await getMapZoneByIdOrThrow(db, mapZoneId);
  return runMapZoneWrite(db, zone.mapId, async (tx) => splitMapZoneInTransaction(
    tx,
    mapZoneId,
    options,
  ));
}

async function splitMapZoneInTransaction(
  db: DatabaseClient,
  mapZoneId: string,
  options?: { splitLine?: GeoJsonGeometry | null },
): Promise<[MapZone, MapZone]> {
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
}

export async function mergeMapZonesById(
  db: DatabaseClient,
  zoneIds: [string, string],
  input: { name?: string } = {},
): Promise<MapZone> {
  const anchorZone = await getMapZoneById(db, zoneIds[0]);
  if (!anchorZone) {
    throw new AppError(errorCodes.validationError, { message: 'Two authored zones are required to merge.' });
  }
  return runMapZoneWrite(db, anchorZone.mapId, async (tx) => mergeMapZonesInTransaction(
    tx,
    zoneIds,
    input,
  ));
}

async function mergeMapZonesInTransaction(
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
    centerLat: map.centerLat,
    centerLng: map.centerLng,
    defaultZoom: map.defaultZoom,
    boundary: map.boundary,
  };
}

export async function validateGeometry(
  db: DatabaseClient,
  geometry: GeoJsonGeometry,
  zone?: { id?: string; name?: string },
): Promise<void> {
  const geometrySql = buildGeometrySql(geometry);
  const result = await db.execute<{ isValid: boolean; reason: string }>(sql`
    SELECT ST_IsValid(${geometrySql}) AS "isValid", ST_IsValidReason(${geometrySql}) AS "reason"
  `);

  if (!result.rows[0]?.isValid) {
    const reason = result.rows[0]?.reason ?? 'Unknown geometry validation failure.';
    // Surface the specific PostGIS reason (e.g. "Self-intersection[lng lat]") and
    // the zone name in the message so the editor can show why a save failed,
    // and stash them in details for the repro log.
    const label = zone?.name ? `Zone "${zone.name}"` : 'This zone';
    throw new AppError(errorCodes.validationError, {
      message: `${label} has an invalid shape after this edit: ${reason}. Nothing was saved.`,
      details: { reason, zoneId: zone?.id, zoneName: zone?.name },
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
