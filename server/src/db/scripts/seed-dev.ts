import { eq } from 'drizzle-orm';
import type { GameSettings, GeoJsonPoint, GeoJsonPolygon, WinConditions } from '@city-game/shared';
import type { DatabaseClient } from '../connection.js';
import { createDb } from '../connection.js';
import { challenges, games, teams } from '../schema.js';
import { createModeRegistry } from '../../modes/index.js';
import { createZone } from '../../services/spatial-service.js';
import { transitionGameLifecycle } from '../../services/game-service.js';

const DEV_SEED_KEY = 'dev_sample_v1';
const DEV_GAME_NAME = 'Winnipeg Territory Demo';
const DEV_GAME_CITY = 'Winnipeg';
const DEV_GAME_URL_BASE = 'http://localhost:5173';

const gameSettings: GameSettings = {
  max_concurrent_claims: 2,
  claim_timeout_minutes: 10,
  location_tracking_enabled: false,
  require_gps_accuracy: false,
};

const winCondition: WinConditions = [
  { type: 'zone_majority', threshold: 0.6 },
  { type: 'time_limit', duration_minutes: 90 },
];

async function main() {
  const { db, pool } = createDb();

  try {
    const existingSeedGame = await findExistingSeedGame(db);
    if (existingSeedGame) {
      await printSummary(db, existingSeedGame.id, 'Existing dev seed found. Reusing it.');
      return;
    }

    const activeGame = await findActiveGame(db);
    if (activeGame) {
      console.log(`An active game already exists: ${activeGame.name} (${activeGame.id}).`);
      console.log(`Open ${DEV_GAME_URL_BASE}/game/${activeGame.id} or end that game before seeding a sample.`);
      return;
    }

    const registry = createModeRegistry();
    const created = await db.transaction(async (tx) => {
      const transactionalDb = tx as unknown as DatabaseClient;

      const [game] = await transactionalDb
        .insert(games)
        .values({
          name: DEV_GAME_NAME,
          modeKey: 'territory',
          city: DEV_GAME_CITY,
          centerLat: '49.8951',
          centerLng: '-97.1384',
          defaultZoom: 13,
          status: 'setup',
          winCondition,
          settings: {
            ...gameSettings,
            seed_key: DEV_SEED_KEY,
          },
        } as typeof games.$inferInsert)
        .returning();

      const insertedTeams = await transactionalDb
        .insert(teams)
        .values([
          {
            gameId: game.id,
            name: 'Red Team',
            color: '#dc2626',
            joinCode: 'RED12345',
            metadata: { seed_key: DEV_SEED_KEY },
          },
          {
            gameId: game.id,
            name: 'Blue Team',
            color: '#2563eb',
            joinCode: 'BLUE1234',
            metadata: { seed_key: DEV_SEED_KEY },
          },
          {
            gameId: game.id,
            name: 'Gold Team',
            color: '#d97706',
            joinCode: 'GOLD1234',
            metadata: { seed_key: DEV_SEED_KEY },
          },
        ])
        .returning();

      const redTeam = insertedTeams.find((team) => team.name === 'Red Team');
      const blueTeam = insertedTeams.find((team) => team.name === 'Blue Team');
      const goldTeam = insertedTeams.find((team) => team.name === 'Gold Team');

      if (!redTeam || !blueTeam || !goldTeam) {
        throw new Error('Failed to create sample teams.');
      }

      const insertedZones: Array<{ id: string; name: string }> = [];

      insertedZones.push(await createZone(transactionalDb, {
        gameId: game.id,
        name: 'The Forks Market',
        geometry: squarePolygon(-97.1302, 49.8892, 0.0016),
        ownerTeamId: redTeam.id,
        pointValue: 3,
        metadata: { seed_key: DEV_SEED_KEY, district: 'Downtown' },
      }));

      insertedZones.push(await createZone(transactionalDb, {
        gameId: game.id,
        name: 'Union Station',
        geometry: pointGeometry(-97.1278, 49.8888),
        ownerTeamId: blueTeam.id,
        pointValue: 2,
        claimRadiusMeters: 85,
        metadata: { seed_key: DEV_SEED_KEY, landmark: true },
      }));

      insertedZones.push(await createZone(transactionalDb, {
        gameId: game.id,
        name: 'Legislative Grounds',
        geometry: squarePolygon(-97.1432, 49.8846, 0.0017),
        ownerTeamId: goldTeam.id,
        pointValue: 4,
        metadata: { seed_key: DEV_SEED_KEY, district: 'Broadway' },
      }));

      insertedZones.push(await createZone(transactionalDb, {
        gameId: game.id,
        name: 'Exchange Square',
        geometry: squarePolygon(-97.1375, 49.8982, 0.0012),
        ownerTeamId: null,
        pointValue: 2,
        metadata: { seed_key: DEV_SEED_KEY, district: 'Exchange' },
      }));

      insertedZones.push(await createZone(transactionalDb, {
        gameId: game.id,
        name: 'St. Boniface Beacon',
        geometry: pointGeometry(-97.1188, 49.8899),
        ownerTeamId: null,
        pointValue: 3,
        claimRadiusMeters: 100,
        metadata: { seed_key: DEV_SEED_KEY, landmark: true },
      }));

      const zoneByName = new Map(insertedZones.map((zone) => [zone.name, zone]));

      await transactionalDb.insert(challenges).values([
        sampleChallenge(game.id, zoneByName.get('The Forks Market')!.id, 'Secure the market concourse', { points: 10, coins: 2 }),
        sampleChallenge(game.id, zoneByName.get('Union Station')!.id, 'Hold the station platform', { points: 8, coins: 1 }),
        sampleChallenge(game.id, zoneByName.get('Legislative Grounds')!.id, 'Control the main lawn', { points: 12, coins: 3 }),
        sampleChallenge(game.id, zoneByName.get('Exchange Square')!.id, 'Sweep the plaza', { points: 9, coins: 2 }),
        sampleChallenge(game.id, zoneByName.get('St. Boniface Beacon')!.id, 'Activate the beacon', { points: 11, coins: 2 }),
      ]);

      await transitionGameLifecycle(transactionalDb, registry, game.id, 'start');

      return {
        gameId: game.id,
      };
    });

    await printSummary(db, created.gameId, 'Seeded a new dev game.');
  } finally {
    await pool.end();
  }
}

async function findExistingSeedGame(db: DatabaseClient) {
  const allGames = await db.select().from(games);

  return allGames.find((game) => {
    const settings = (game.settings ?? {}) as Record<string, unknown>;
    return settings.seed_key === DEV_SEED_KEY;
  }) ?? null;
}

async function findActiveGame(db: DatabaseClient) {
  const [game] = await db.select().from(games).where(eq(games.status, 'active')).limit(1);
  return game ?? null;
}

async function printSummary(db: DatabaseClient, gameId: string, title: string) {
  const [game] = await db.select().from(games).where(eq(games.id, gameId)).limit(1);
  const gameTeams = await db.select().from(teams).where(eq(teams.gameId, gameId));

  if (!game) {
    throw new Error(`Seeded game ${gameId} not found.`);
  }

  console.log(title);
  console.log(`Game: ${game.name}`);
  console.log(`Game ID: ${game.id}`);
  console.log(`Status: ${game.status}`);
  console.log(`Open: ${DEV_GAME_URL_BASE}/game/${game.id}`);
  console.log('Join codes:');

  for (const team of gameTeams) {
    console.log(`- ${team.name}: ${team.joinCode}`);
  }
}

function pointGeometry(lng: number, lat: number): GeoJsonPoint {
  return {
    type: 'Point',
    coordinates: [lng, lat],
  };
}

function squarePolygon(lng: number, lat: number, size: number): GeoJsonPolygon {
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

function sampleChallenge(
  gameId: string,
  zoneId: string,
  title: string,
  scoring: Record<string, number>,
): typeof challenges.$inferInsert {
  return {
    gameId,
    zoneId,
    title,
    description: title,
    kind: 'visit',
    config: {
      seed_key: DEV_SEED_KEY,
      instructions: 'Walk into the zone and complete the action from the app.',
    },
    completionMode: 'self_report',
    scoring,
    difficulty: 'easy',
    status: 'available',
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
