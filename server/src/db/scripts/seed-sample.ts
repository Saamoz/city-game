import { eq, sql } from 'drizzle-orm';
import type { GameSettings, GeoJsonGeometry, GeoJsonPoint, GeoJsonPolygon, WinConditions } from '@city-game/shared';
import type { DatabaseClient } from '../connection.js';
import { createDb } from '../connection.js';
import { challenges, games, teams, zones } from '../schema.js';
import { createModeRegistry } from '../../modes/index.js';
import { transitionGameLifecycle } from '../../services/game-service.js';
import { createMap, createMapZone } from '../../services/map-service.js';

const DEV_GAME_URL_BASE = 'http://localhost:5173';
const RESET_TABLES = [
  'player_location_samples',
  'annotations',
  'action_receipts',
  'game_events',
  'resource_ledger',
  'challenge_claims',
  'challenges',
  'zones',
  'map_zones',
  'players',
  'teams',
  'games',
  'maps',
] as const;

export interface TeamSeed {
  name: string;
  color: string;
  joinCode: string;
}

export interface ZoneSeed {
  name: string;
  geometry: GeoJsonGeometry;
  ownerTeamName?: string | null;
  pointValue: number;
  claimRadiusMeters?: number;
  metadata?: Record<string, unknown>;
}

export interface ChallengeSeed {
  title: string;
  zoneName?: string;
  shortDescription?: string;
  longDescription?: string;
  scoring: Record<string, number>;
  portable?: boolean;
}

export interface SampleSeedConfig {
  seedKey: string;
  name: string;
  city: string;
  centerLat: number;
  centerLng: number;
  defaultZoom: number;
  settings: GameSettings;
  winCondition: WinConditions;
  teams: TeamSeed[];
  zones: ZoneSeed[];
  challenges: ChallengeSeed[];
}

export async function runSampleSeed(config: SampleSeedConfig, options?: { clearExisting?: boolean; reuseExistingSeed?: boolean }) {
  const { db, pool } = createDb();

  try {
    if (options?.clearExisting) {
      await resetDatabase(db);
    }

    if (options?.reuseExistingSeed) {
      const existingSeedGame = await findExistingSeedGame(db, config.seedKey);
      if (existingSeedGame?.status === 'active') {
        await printSummary(db, existingSeedGame.id, 'Existing active dev seed found. Reusing it.');
        return;
      }

      const activeGame = await findActiveGame(db);
      if (activeGame) {
        console.log('An active game already exists: ' + activeGame.name + ' (' + activeGame.id + ').');
        console.log('Open ' + DEV_GAME_URL_BASE + '/game/' + activeGame.id + ' or end that game before seeding a sample.');
        return;
      }
    }

    const registry = createModeRegistry();
    const created = await db.transaction(async (tx) => {
      const transactionalDb = tx as unknown as DatabaseClient;

      const map = await createMap(transactionalDb, {
        name: config.city + ' Base Map',
        city: config.city,
        centerLat: config.centerLat,
        centerLng: config.centerLng,
        defaultZoom: config.defaultZoom,
        metadata: {
          seed_key: config.seedKey,
          source: 'sample_seed',
        },
      });

      for (const zone of config.zones) {
        await createMapZone(transactionalDb, {
          mapId: map.id,
          name: zone.name,
          geometry: zone.geometry,
          pointValue: zone.pointValue,
          claimRadiusMeters: zone.claimRadiusMeters ?? null,
          metadata: {
            seed_key: config.seedKey,
            ...(zone.metadata ?? {}),
          },
        });
      }

      const [game] = await transactionalDb
        .insert(games)
        .values({
          mapId: map.id,
          name: config.name,
          modeKey: 'territory',
          city: config.city,
          centerLat: String(config.centerLat),
          centerLng: String(config.centerLng),
          defaultZoom: config.defaultZoom,
          status: 'setup',
          winCondition: config.winCondition,
          settings: {
            ...config.settings,
            seed_key: config.seedKey,
            map_id: map.id,
          },
        } as typeof games.$inferInsert)
        .returning();

      const insertedTeams = await transactionalDb
        .insert(teams)
        .values(config.teams.map((team) => ({
          gameId: game.id,
          name: team.name,
          color: team.color,
          joinCode: team.joinCode,
          metadata: { seed_key: config.seedKey },
        })))
        .returning();

      const teamByName = new Map(insertedTeams.map((team) => [team.name, team]));

      await transitionGameLifecycle(transactionalDb, registry, game.id, 'start');

      const runtimeZones = await transactionalDb.select().from(zones).where(eq(zones.gameId, game.id));
      const runtimeZoneByName = new Map(runtimeZones.map((zone) => [zone.name, zone]));
      const capturedAt = new Date();

      for (const zoneSeed of config.zones) {
        if (!zoneSeed.ownerTeamName) {
          continue;
        }

        const runtimeZone = runtimeZoneByName.get(zoneSeed.name);
        const ownerTeam = teamByName.get(zoneSeed.ownerTeamName);
        if (!runtimeZone || !ownerTeam) {
          continue;
        }

        await transactionalDb
          .update(zones)
          .set({
            ownerTeamId: ownerTeam.id,
            capturedAt,
            updatedAt: capturedAt,
          })
          .where(eq(zones.id, runtimeZone.id));
      }

      const refreshedRuntimeZones = await transactionalDb.select().from(zones).where(eq(zones.gameId, game.id));
      const refreshedRuntimeZoneByName = new Map(refreshedRuntimeZones.map((zone) => [zone.name, zone]));

      await transactionalDb.insert(challenges).values(config.challenges.map((challenge) => {
        const zoneId = challenge.zoneName ? (refreshedRuntimeZoneByName.get(challenge.zoneName)?.id ?? null) : null;
        if (challenge.zoneName && !zoneId) {
          throw new Error('Challenge ' + challenge.title + ' references missing zone ' + challenge.zoneName + '.');
        }

        const shortDescription = challenge.shortDescription?.trim() || challenge.title;
        const longDescription = challenge.longDescription?.trim() || shortDescription;
        const portable = challenge.portable ?? !challenge.zoneName;

        return {
          gameId: game.id,
          zoneId,
          title: challenge.title,
          description: shortDescription,
          kind: 'visit',
          config: {
            seed_key: config.seedKey,
            portable,
            short_description: shortDescription,
            long_description: longDescription,
          },
          completionMode: 'self_report',
          scoring: challenge.scoring,
          difficulty: 'easy',
          status: 'available',
        };
      }));

      return { gameId: game.id };
    });

    await printSummary(db, created.gameId, 'Seeded a new sample game.');
  } finally {
    await pool.end();
  }
}

export async function resetDatabase(db: DatabaseClient) {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS postgis`);
  await db.execute(sql.raw('TRUNCATE TABLE ' + RESET_TABLES.join(', ') + ' RESTART IDENTITY CASCADE'));
}

async function findExistingSeedGame(db: DatabaseClient, seedKey: string) {
  const allGames = await db.select().from(games);

  return allGames
    .filter((game) => {
      const settings = (game.settings ?? {}) as Record<string, unknown>;
      return settings.seed_key === seedKey;
    })
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
}

async function findActiveGame(db: DatabaseClient) {
  const [game] = await db.select().from(games).where(eq(games.status, 'active')).limit(1);
  return game ?? null;
}

async function printSummary(db: DatabaseClient, gameId: string, title: string) {
  const [game] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  const gameTeams = await db.select().from(teams).where(eq(teams.gameId, gameId));

  if (!game) {
    throw new Error('Seeded game ' + gameId + ' not found.');
  }

  console.log(title);
  console.log('Game: ' + game.name);
  console.log('Game ID: ' + game.id);
  console.log('Map ID: ' + (game.mapId ?? 'none'));
  console.log('Status: ' + game.status);
  console.log('Open: ' + DEV_GAME_URL_BASE + '/game/' + game.id);
  console.log('Join codes:');

  for (const team of gameTeams) {
    console.log('- ' + team.name + ': ' + team.joinCode);
  }
}

export function pointGeometry(lng: number, lat: number): GeoJsonPoint {
  return {
    type: 'Point',
    coordinates: [lng, lat],
  };
}

export function squarePolygon(lng: number, lat: number, size: number): GeoJsonPolygon {
  return {
    type: 'Polygon',
    coordinates: [[
      [lng - size, lat - size],
      [lng + size, lat - size],
      [lng + size, lat + size],
      [lng - size, lat + size],
      [lng - size, lat - size],
    ]],
  };
}
