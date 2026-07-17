import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GeoJsonGeometry } from '@city-game/shared';

/**
 * Boundary-edit repro logging.
 *
 * RULE: every zone-geometry write from the map editor (a boundary "move",
 * a carve-on-draw, a split, a merge) records a self-contained JSON file
 * containing the exact inputs — enough to replay the operation deterministically
 * with `pnpm --filter @city-game/server exec tsx src/db/scripts/replay-zone-edit.ts <file>`.
 * This is ALWAYS on (no flag) so that any move a user makes, successful or not,
 * can be reproduced exactly from the log without having to reconstruct the
 * client-side gesture. A one-line summary is also printed to the server console
 * (console.error on failure, console.log on success) so the file is easy to find.
 *
 * Files land in ZONE_EDIT_LOG_DIR (default `<cwd>/zone-edit-logs`, gitignored)
 * and the directory is capped at MAX_FILES most-recent entries.
 */

const LOG_DIR = process.env.ZONE_EDIT_LOG_DIR ?? join(process.cwd(), 'zone-edit-logs');
const MAX_FILES = 200;

export interface ZoneEditReproUpdate {
  zoneId: string;
  zoneName?: string;
  /** The exact geometry the client asked to write (the "after" shape). */
  geometry: GeoJsonGeometry;
  /** The zone's geometry before this edit, when available — lets a replay show the diff. */
  previousGeometry?: GeoJsonGeometry;
}

export interface ZoneEditReproOutcome {
  ok: boolean;
  /** The zone whose geometry PostGIS rejected, if the failure was per-zone. */
  failedZoneId?: string;
  failedZoneName?: string;
  /** ST_IsValidReason text, or the constraint / error message. */
  reason?: string;
  message?: string;
}

export interface ZoneEditReproEntry {
  kind: 'geometry-save' | 'carve-create' | 'split' | 'merge';
  mapId: string;
  updates: ZoneEditReproUpdate[];
  outcome: ZoneEditReproOutcome;
  /** Anything extra worth capturing for the specific kind (split line, merged ids, ...). */
  context?: Record<string, unknown>;
}

export function recordZoneEdit(entry: ZoneEditReproEntry): string | null {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = Math.random().toString(36).slice(2, 8);
    const status = entry.outcome.ok ? 'ok' : 'FAIL';
    const file = join(LOG_DIR, `zone-edit-${stamp}-${status}-${suffix}.json`);
    writeFileSync(file, JSON.stringify({ recordedAt: new Date().toISOString(), ...entry }, null, 2));

    const zoneCount = entry.updates.length;
    if (entry.outcome.ok) {
      console.log(`[zone-edit] OK ${entry.kind} map=${entry.mapId} zones=${zoneCount} → ${file}`);
    } else {
      const who = entry.outcome.failedZoneName ?? entry.outcome.failedZoneId ?? 'map';
      const why = entry.outcome.reason ?? entry.outcome.message ?? 'unknown';
      console.error(`[zone-edit] FAIL ${entry.kind} map=${entry.mapId} zone="${who}" reason="${why}" → replay with: tsx src/db/scripts/replay-zone-edit.ts "${file}"`);
    }

    pruneOldEntries();
    return file;
  } catch (error) {
    console.error('[zone-edit] could not write repro log:', error);
    return null;
  }
}

/** Builds a failure outcome from a thrown error, pulling out the ST_IsValidReason when present. */
export function reproOutcomeFromError(error: unknown, fallbackZone?: { id?: string; name?: string }): ZoneEditReproOutcome {
  const appError = error as { message?: string; details?: { reason?: string; zoneId?: string; zoneName?: string; constraint?: string } };
  const details = appError?.details;
  return {
    ok: false,
    failedZoneId: details?.zoneId ?? fallbackZone?.id,
    failedZoneName: details?.zoneName ?? fallbackZone?.name,
    reason: details?.reason ?? details?.constraint,
    message: appError?.message ?? String(error),
  };
}

function pruneOldEntries(): void {
  try {
    const files = readdirSync(LOG_DIR)
      .filter((name) => name.startsWith('zone-edit-') && name.endsWith('.json'))
      .sort(); // ISO-timestamp prefix sorts chronologically
    for (const name of files.slice(0, Math.max(0, files.length - MAX_FILES))) {
      rmSync(join(LOG_DIR, name), { force: true });
    }
  } catch {
    // best-effort cleanup only
  }
}
