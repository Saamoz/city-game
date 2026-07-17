import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { GeoJsonGeometry } from '@city-game/shared';
import { createDb } from '../connection.js';
import { updateMapZoneGeometries } from '../../services/map-service.js';

/**
 * Replays a zone-edit repro file written by the map editor (see
 * server/src/lib/zone-edit-repro.ts). Given the JSON log for a boundary "move"
 * that a user made, this reproduces it deterministically against the current
 * database:
 *
 *   pnpm --filter @city-game/server exec tsx src/db/scripts/replay-zone-edit.ts <file> [--apply]
 *
 * By default it only re-runs PostGIS validation on each written geometry and
 * prints the exact ST_IsValidReason (the cheap, side-effect-free repro). Pass
 * --apply to re-run the whole updateMapZoneGeometries transaction against the
 * map named in the log (must still exist), reproducing the real save.
 */

interface ReproFile {
  kind: string;
  mapId: string;
  updates: Array<{ zoneId: string; zoneName?: string; geometry: GeoJsonGeometry; previousGeometry?: GeoJsonGeometry }>;
  outcome: { ok: boolean; failedZoneId?: string; failedZoneName?: string; reason?: string; message?: string };
}

const { db, pool } = createDb();

async function main() {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!file) {
    console.error('usage: replay-zone-edit.ts <repro-file.json> [--apply]');
    process.exit(2);
  }

  const entry = JSON.parse(readFileSync(file, 'utf8')) as ReproFile;
  console.log(`Replaying ${entry.kind} on map ${entry.mapId} (${entry.updates.length} zone(s))`);
  console.log(`Logged outcome: ${entry.outcome.ok ? 'OK' : `FAIL — ${entry.outcome.failedZoneName ?? entry.outcome.failedZoneId ?? 'map'}: ${entry.outcome.reason ?? entry.outcome.message}`}`);
  console.log('');

  for (const update of entry.updates) {
    const geomSql = sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(update.geometry)}), 4326)`;
    const r = await db.execute<{ valid: boolean; reason: string }>(sql`
      SELECT ST_IsValid(${geomSql}) AS valid, ST_IsValidReason(${geomSql}) AS reason
    `);
    const valid = Boolean(r.rows[0]?.valid);
    console.log(`  ${valid ? 'valid  ' : 'INVALID'}  ${update.zoneName ?? update.zoneId}: ${r.rows[0]?.reason}`);
  }

  if (apply) {
    console.log('\n--apply: re-running the real save transaction...');
    try {
      const zones = await updateMapZoneGeometries(db, entry.mapId, entry.updates.map((u) => ({ zoneId: u.zoneId, geometry: u.geometry })));
      console.log(`Save succeeded, map now has ${zones.length} zones.`);
    } catch (error) {
      console.log('Save failed:', error instanceof Error ? error.message : error);
    }
  }

  await pool?.end();
}

main().catch((error) => { console.error(error); process.exit(1); });
