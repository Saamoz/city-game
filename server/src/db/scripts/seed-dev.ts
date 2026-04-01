import type { GameSettings, WinConditions } from '@city-game/shared';
import { pointGeometry, runSampleSeed, squarePolygon, type SampleSeedConfig } from './seed-sample.js';

const DEV_SEED_KEY = 'dev_sample_v1';

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

const config: SampleSeedConfig = {
  seedKey: DEV_SEED_KEY,
  name: 'Winnipeg Territory Demo',
  city: 'Winnipeg',
  centerLat: 49.8951,
  centerLng: -97.1384,
  defaultZoom: 13,
  settings: gameSettings,
  winCondition,
  teams: [
    { name: 'Red Team', color: '#dc2626', joinCode: 'RED12345' },
    { name: 'Blue Team', color: '#2563eb', joinCode: 'BLUE1234' },
    { name: 'Gold Team', color: '#d97706', joinCode: 'GOLD1234' },
  ],
  zones: [
    {
      name: 'The Forks Market',
      geometry: squarePolygon(-97.1302, 49.8892, 0.0016),
      ownerTeamName: 'Red Team',
      pointValue: 3,
      metadata: { district: 'Downtown' },
    },
    {
      name: 'Union Station',
      geometry: pointGeometry(-97.1278, 49.8888),
      ownerTeamName: 'Blue Team',
      pointValue: 2,
      claimRadiusMeters: 85,
      metadata: { landmark: true },
    },
    {
      name: 'Legislative Grounds',
      geometry: squarePolygon(-97.1432, 49.8846, 0.0017),
      ownerTeamName: 'Gold Team',
      pointValue: 4,
      metadata: { district: 'Broadway' },
    },
    {
      name: 'Exchange Square',
      geometry: squarePolygon(-97.1375, 49.8982, 0.0012),
      pointValue: 2,
      metadata: { district: 'Exchange' },
    },
    {
      name: 'St. Boniface Beacon',
      geometry: pointGeometry(-97.1188, 49.8899),
      pointValue: 3,
      claimRadiusMeters: 100,
      metadata: { landmark: true },
    },
  ],
  challenges: [
    { zoneName: 'The Forks Market', title: 'Secure the market concourse', scoring: { points: 10, coins: 2 } },
    { zoneName: 'Union Station', title: 'Hold the station platform', scoring: { points: 8, coins: 1 } },
    { zoneName: 'Legislative Grounds', title: 'Control the main lawn', scoring: { points: 12, coins: 3 } },
    { zoneName: 'Exchange Square', title: 'Sweep the plaza', scoring: { points: 9, coins: 2 } },
    { zoneName: 'St. Boniface Beacon', title: 'Activate the beacon', scoring: { points: 11, coins: 2 } },
  ],
};

void runSampleSeed(config, { reuseExistingSeed: true }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
