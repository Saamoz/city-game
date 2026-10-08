import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import {
  errorCodes,
  type GameEventRecord,
  type GameRecap,
  type GameRecapMoment,
  type GameRecapPoint,
  type GeoJsonPoint,
  type JsonObject,
  type TeamRecapPath,
} from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { playerLocationSamples, teams } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { ModeRegistry } from '../modes/index.js';
import { getRecentEvents } from './event-service.js';
import { getGameById } from './game-service.js';
import { getJudgingSummary } from './judging-service.js';
import { getScoreboard } from './scoreboard-service.js';

const MAX_RECAP_EVENTS = 5_000;
const MAX_ACCEPTED_ACCURACY_METERS = 180;
const MAX_SHORT_HOP_SPEED_MPS = 70;
const SHORT_HOP_WINDOW_MS = 120_000;

export interface RawLocationPoint {
  teamId: string;
  recordedAt: Date;
  location: GeoJsonPoint;
  gpsErrorMeters: number | null;
}

export async function buildGameRecap(
  db: DatabaseClient,
  registry: ModeRegistry,
  gameId: string,
): Promise<GameRecap> {
  const game = await getGameById(db, gameId);
  if (game.status !== 'completed' || !game.startedAt || !game.endedAt) {
    throw new AppError(errorCodes.invalidGameStateTransition, {
      message: 'The recap becomes available after the game is finished.',
      details: { currentStatus: game.status },
    });
  }

  const [scoreboard, eventRows, locationRows, teamRows, judging] = await Promise.all([
    getScoreboard(db, registry, gameId),
    getRecentEvents(db, { gameId, limit: MAX_RECAP_EVENTS }),
    db
      .select({
        teamId: playerLocationSamples.teamId,
        recordedAt: playerLocationSamples.recordedAt,
        location: sql<GeoJsonPoint>`ST_AsGeoJSON(${playerLocationSamples.location})::json`,
        gpsErrorMeters: playerLocationSamples.gpsErrorMeters,
      })
      .from(playerLocationSamples)
      .where(and(eq(playerLocationSamples.gameId, gameId), isNotNull(playerLocationSamples.teamId)))
      .orderBy(asc(playerLocationSamples.recordedAt)),
    db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.gameId, gameId)),
    getJudgingSummary(db, gameId, game.settings),
  ]);

  const startedAtMs = game.startedAt.getTime();
  const endedAtMs = game.endedAt.getTime();
  const gameDurationMs = Math.max(1, endedAtMs - startedAtMs);
  const teamNameById = new Map(teamRows.map((team) => [team.id, team.name]));
  const events = [...eventRows].reverse();
  const paths = buildTeamPaths(locationRows.flatMap((row) => row.teamId ? [{ ...row, teamId: row.teamId }] : []), startedAtMs, endedAtMs);

  return {
    gameId,
    startedAt: game.startedAt.toISOString(),
    endedAt: game.endedAt.toISOString(),
    playbackDurationSeconds: clamp(Math.round(gameDurationMs / 360_000), 30, 60),
    scoreboard,
    paths,
    moments: buildRecapMoments(events, teamNameById, startedAtMs, gameDurationMs, paths),
    events,
    judging,
  };
}

export function cleanLocationPath(points: RawLocationPoint[]): RawLocationPoint[] {
  const candidates = points
    .filter((point) => {
      const [lng, lat] = point.location.coordinates;
      return Number.isFinite(lat)
        && Number.isFinite(lng)
        && lat >= -90
        && lat <= 90
        && lng >= -180
        && lng <= 180
        && (point.gpsErrorMeters === null || point.gpsErrorMeters <= MAX_ACCEPTED_ACCURACY_METERS);
    })
    .sort((left, right) => left.recordedAt.getTime() - right.recordedAt.getTime());

  if (candidates.length < 3) return candidates;

  const withoutSpikes = candidates.filter((point, index) => {
    if (index === 0 || index === candidates.length - 1) return true;
    const previous = candidates[index - 1]!;
    const next = candidates[index + 1]!;
    return !(speedBetween(previous, point) > MAX_SHORT_HOP_SPEED_MPS
      && speedBetween(point, next) > MAX_SHORT_HOP_SPEED_MPS
      && speedBetween(previous, next) <= MAX_SHORT_HOP_SPEED_MPS);
  });

  return withoutSpikes.filter((point, index) => {
    if (index === 0) return true;
    const previous = withoutSpikes[index - 1]!;
    const elapsedMs = point.recordedAt.getTime() - previous.recordedAt.getTime();
    return elapsedMs >= SHORT_HOP_WINDOW_MS || speedBetween(previous, point) <= MAX_SHORT_HOP_SPEED_MPS;
  });
}

function buildTeamPaths(rows: RawLocationPoint[], startedAtMs: number, endedAtMs: number): TeamRecapPath[] {
  const rowsByTeam = new Map<string, RawLocationPoint[]>();
  for (const row of rows) {
    const current = rowsByTeam.get(row.teamId) ?? [];
    current.push(row);
    rowsByTeam.set(row.teamId, current);
  }

  return [...rowsByTeam]
    .map(([teamId, points]) => ({
      teamId,
      points: cleanLocationPath(points).map((point): GameRecapPoint => ({
        lng: point.location.coordinates[0],
        lat: point.location.coordinates[1],
        recordedAt: point.recordedAt.toISOString(),
        progress: progressAt(point.recordedAt.getTime(), startedAtMs, endedAtMs - startedAtMs),
      })),
    }))
    .filter((path) => path.points.length > 0);
}

function buildRecapMoments(
  events: GameEventRecord[],
  teamNameById: Map<string, string>,
  startedAtMs: number,
  gameDurationMs: number,
  paths: TeamRecapPath[] = [],
): GameRecapMoment[] {
  return events.flatMap((event): GameRecapMoment[] => {
    const challenge = asNamedObject(event.meta.challenge);
    const zone = asNamedObject(event.meta.zone);
    const teamName = event.actorTeamId ? teamNameById.get(event.actorTeamId) ?? 'A team' : null;
    const base = {
      id: event.id,
      teamId: event.actorTeamId,
      zoneId: zone?.id ?? null,
      occurredAt: event.createdAt,
      progress: progressAt(new Date(event.createdAt).getTime(), startedAtMs, gameDurationMs),
    };

    if (event.eventType === 'CHALLENGE_COMPLETED') {
      return [{
        ...base,
        type: 'challenge_completed',
        title: `${teamName ?? 'A team'} completed ${challenge?.name ?? 'a challenge'}`,
        detail: zone?.name ? `${zone.name} captured` : null,
        location: findCompletionLocation(event, paths, base.progress),
      }];
    }
    if (event.eventType === 'CHALLENGE_REROLL_STATE_CHANGED' && asObject(event.afterState)?.didReroll === true) {
      return [{ ...base, type: 'challenge_rerolled', title: `${challenge?.name ?? 'A challenge'} was rerolled`, detail: 'The teams unanimously chose a replacement.' }];
    }
    if (event.eventType === 'GAME_PAUSED' || event.eventType === 'GAME_RESUMED') {
      return [{ ...base, type: event.eventType === 'GAME_PAUSED' ? 'game_paused' : 'game_resumed', title: event.eventType === 'GAME_PAUSED' ? 'Game paused' : 'Game resumed', detail: null }];
    }
    return [];
  });
}

// Where a challenge was completed: the GPS fix stored on the claim, then the challenge's own pin or
// area, then wherever the team's trail puts them at that moment.
export function findCompletionLocation(event: GameEventRecord, paths: TeamRecapPath[], progress: number): { lng: number; lat: number } | null {
  const claimPoint = asPoint(asObject(event.meta.claim)?.locationAtClaim);
  if (claimPoint) return claimPoint;

  const config = asObject(asObject(event.meta.challenge)?.config);
  const pinPoint = asPoint(config?.map_point) ?? asPoint(config?.source_map_point);
  if (pinPoint) return pinPoint;
  const areaCenter = areaCentroid(config?.area);
  if (areaCenter) return areaCenter;

  const path = paths.find((entry) => entry.teamId === event.actorTeamId);
  if (!path?.points.length) return null;
  const nextIndex = path.points.findIndex((point) => point.progress > progress);
  if (nextIndex === 0) return null;
  if (nextIndex < 0) {
    const last = path.points[path.points.length - 1]!;
    return { lng: last.lng, lat: last.lat };
  }
  const previous = path.points[nextIndex - 1]!;
  const next = path.points[nextIndex]!;
  const amount = (progress - previous.progress) / Math.max(0.000001, next.progress - previous.progress);
  return { lng: previous.lng + (next.lng - previous.lng) * amount, lat: previous.lat + (next.lat - previous.lat) * amount };
}

function asPoint(value: unknown): { lng: number; lat: number } | null {
  if (typeof value === 'string') return parseEwkbPoint(value);
  const object = asObject(value);
  const coordinates = object?.type === 'Point' && Array.isArray(object.coordinates) ? object.coordinates : null;
  const [lng, lat] = coordinates ?? [];
  return typeof lng === 'number' && typeof lat === 'number' && Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
}

// Claims store their GPS fix as PostGIS hex EWKB (e.g. 0101000020E6100000…), not GeoJSON.
export function parseEwkbPoint(hex: string): { lng: number; lat: number } | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 42) return null;
  const bytes = Buffer.from(hex, 'hex');
  const littleEndian = bytes[0] === 1;
  const type = littleEndian ? bytes.readUInt32LE(1) : bytes.readUInt32BE(1);
  if ((type & 0xff) !== 1) return null;
  const offset = type & 0x20000000 ? 9 : 5;
  if (bytes.length < offset + 16) return null;
  const lng = littleEndian ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset);
  const lat = littleEndian ? bytes.readDoubleLE(offset + 8) : bytes.readDoubleBE(offset + 8);
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
}

function areaCentroid(value: unknown): { lng: number; lat: number } | null {
  const object = asObject(value);
  if (!object || !Array.isArray(object.coordinates)) return null;
  const ring = (object.type === 'MultiPolygon' ? (object.coordinates[0] as unknown[] | undefined)?.[0] : object.coordinates[0]) as unknown;
  if (!Array.isArray(ring) || ring.length === 0) return null;
  const positions = ring.filter((position): position is [number, number] => Array.isArray(position) && typeof position[0] === 'number' && typeof position[1] === 'number');
  if (!positions.length) return null;
  return {
    lng: positions.reduce((sum, position) => sum + position[0], 0) / positions.length,
    lat: positions.reduce((sum, position) => sum + position[1], 0) / positions.length,
  };
}

function speedBetween(left: RawLocationPoint, right: RawLocationPoint): number {
  const elapsedSeconds = Math.max(0.001, (right.recordedAt.getTime() - left.recordedAt.getTime()) / 1_000);
  const [leftLng, leftLat] = left.location.coordinates;
  const [rightLng, rightLat] = right.location.coordinates;
  return haversineMeters(leftLat, leftLng, rightLat, rightLng) / elapsedSeconds;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radians = Math.PI / 180;
  const deltaLat = (lat2 - lat1) * radians;
  const deltaLng = (lng2 - lng1) * radians;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(deltaLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function progressAt(timestampMs: number, startedAtMs: number, durationMs: number): number {
  return clamp((timestampMs - startedAtMs) / Math.max(1, durationMs), 0, 1);
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function asNamedObject(value: unknown): { id: string | null; name: string | null } | null {
  const object = asObject(value);
  if (!object) return null;
  return {
    id: typeof object.id === 'string' ? object.id : null,
    name: typeof object.name === 'string' ? object.name : typeof object.title === 'string' ? object.title : null,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
