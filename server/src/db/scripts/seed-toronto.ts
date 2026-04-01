import type { GameSettings, WinConditions } from '@city-game/shared';
import { pointGeometry, runSampleSeed, squarePolygon, type SampleSeedConfig } from './seed-sample.js';

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
  seedKey: 'toronto_sample_v1',
  name: 'Toronto Territory Demo',
  city: 'Toronto',
  centerLat: 43.6532,
  centerLng: -79.3832,
  defaultZoom: 12,
  settings: gameSettings,
  winCondition,
  teams: [
    { name: 'Scarlet Team', color: '#dc2626', joinCode: 'TORRED01' },
    { name: 'Harbour Team', color: '#2563eb', joinCode: 'TORBLUE1' },
    { name: 'Signal Team', color: '#d97706', joinCode: 'TORGOLD1' },
  ],
  zones: [
    {
      name: 'Union Station Concourse',
      geometry: squarePolygon(-79.3808, 43.6453, 0.0014),
      ownerTeamName: 'Scarlet Team',
      pointValue: 3,
      metadata: { district: 'South Core' },
    },
    {
      name: 'CN Tower Plaza',
      geometry: pointGeometry(-79.3871, 43.6426),
      ownerTeamName: 'Harbour Team',
      pointValue: 2,
      claimRadiusMeters: 90,
      metadata: { landmark: true },
    },
    {
      name: 'Nathan Phillips Square',
      geometry: squarePolygon(-79.3842, 43.6526, 0.0016),
      ownerTeamName: 'Signal Team',
      pointValue: 4,
      metadata: { district: 'Old Toronto' },
    },
    {
      name: 'Distillery Courtyard',
      geometry: squarePolygon(-79.3592, 43.6505, 0.00125),
      pointValue: 2,
      metadata: { district: 'Distillery' },
    },
    {
      name: 'Harbourfront Beacon',
      geometry: pointGeometry(-79.3801, 43.6389),
      pointValue: 3,
      claimRadiusMeters: 100,
      metadata: { landmark: true },
    },
  ],
  challenges: [
    { zoneName: 'Union Station Concourse', title: 'Lock down the concourse', scoring: { points: 10, coins: 2 } },
    { zoneName: 'CN Tower Plaza', title: 'Trigger the tower signal', scoring: { points: 8, coins: 1 } },
    { zoneName: 'Nathan Phillips Square', title: 'Control the square centerline', scoring: { points: 12, coins: 3 } },
    { zoneName: 'Distillery Courtyard', title: 'Sweep the brick courtyard', scoring: { points: 9, coins: 2 } },
    { zoneName: 'Harbourfront Beacon', title: 'Anchor the waterfront beacon', scoring: { points: 11, coins: 2 } },
  ],
};

void runSampleSeed(config, { clearExisting: true }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
