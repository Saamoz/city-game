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
  seedKey: 'chicago_sample_v1',
  name: 'Chicago Territory Demo',
  city: 'Chicago',
  centerLat: 41.8781,
  centerLng: -87.6298,
  defaultZoom: 12,
  settings: gameSettings,
  winCondition,
  teams: [
    { name: 'Lake Team', color: '#2563eb', joinCode: 'CHIBLUE1' },
    { name: 'Ember Team', color: '#dc2626', joinCode: 'CHIRED01' },
    { name: 'Crown Team', color: '#d97706', joinCode: 'CHIGOLD1' },
  ],
  zones: [
    {
      name: 'Millennium Park Bowl',
      geometry: squarePolygon(-87.6227, 41.8827, 0.0016),
      ownerTeamName: 'Lake Team',
      pointValue: 3,
      metadata: { district: 'Loop' },
    },
    {
      name: 'Union Station Hall',
      geometry: pointGeometry(-87.6401, 41.8786),
      ownerTeamName: 'Ember Team',
      pointValue: 2,
      claimRadiusMeters: 90,
      metadata: { landmark: true },
    },
    {
      name: 'Riverwalk Crossing',
      geometry: squarePolygon(-87.6319, 41.8881, 0.00145),
      ownerTeamName: 'Crown Team',
      pointValue: 4,
      metadata: { district: 'River North' },
    },
    {
      name: 'Grant Park Fieldhouse',
      geometry: squarePolygon(-87.6248, 41.8721, 0.00135),
      pointValue: 2,
      metadata: { district: 'South Loop' },
    },
    {
      name: 'Navy Pier Signal',
      geometry: pointGeometry(-87.6079, 41.8917),
      pointValue: 3,
      claimRadiusMeters: 105,
      metadata: { landmark: true },
    },
  ],
  challenges: [
    { zoneName: 'Millennium Park Bowl', title: 'Take the park bowl', scoring: { points: 10, coins: 2 } },
    { zoneName: 'Union Station Hall', title: 'Hold the terminal hall', scoring: { points: 8, coins: 1 } },
    { zoneName: 'Riverwalk Crossing', title: 'Control the river crossing', scoring: { points: 12, coins: 3 } },
    { zoneName: 'Grant Park Fieldhouse', title: 'Sweep the fieldhouse block', scoring: { points: 9, coins: 2 } },
    { zoneName: 'Navy Pier Signal', title: 'Activate the pier signal', scoring: { points: 11, coins: 2 } },
  ],
};

void runSampleSeed(config, { clearExisting: true }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
