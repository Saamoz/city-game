import type { GameSettings, WinConditions } from '@city-game/shared';
import { gridCellPolygon, runSampleSeed, type SampleSeedConfig } from './seed-sample.js';

const DEV_SEED_KEY = 'dev_sample_v1';

// Zones tile a 3x2 grid over downtown Winnipeg so they share borders and form a
// playable map (games refuse maps with overlapping or disconnected zones).
const cell = (column: number, row: number, columnSpan = 1) =>
  gridCellPolygon(-97.147, 49.883, 0.009, 0.0075, column, row, columnSpan);

const gameSettings: GameSettings = {
  max_concurrent_claims: 2,
  claim_timeout_minutes: 10,
  require_gps_accuracy: false,
};

const winCondition: WinConditions = [
  { type: 'zone_majority', threshold: 0.6 },
  { type: 'time_limit', duration_minutes: 90 },
];

const config: SampleSeedConfig = {
  seedKey: DEV_SEED_KEY,
  name: 'Winnipeg Territory Demo',
  mapName: 'Winnipeg Base Map',
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
      geometry: cell(1, 0),
      ownerTeamName: 'Red Team',
      pointValue: 3,
      metadata: { district: 'Downtown' },
    },
    {
      name: 'Union Station',
      geometry: cell(2, 1),
      ownerTeamName: 'Blue Team',
      pointValue: 2,
      metadata: { landmark: true },
    },
    {
      name: 'Legislative Grounds',
      geometry: cell(0, 0),
      ownerTeamName: 'Gold Team',
      pointValue: 4,
      metadata: { district: 'Broadway' },
    },
    {
      name: 'Exchange Square',
      geometry: cell(0, 1, 2),
      pointValue: 2,
      metadata: { district: 'Exchange' },
    },
    {
      name: 'St. Boniface Beacon',
      geometry: cell(2, 0),
      pointValue: 3,
      metadata: { landmark: true },
    },
  ],
  challenges: [
    {
      title: 'Signal Check',
      shortDescription: 'Verify the zone and lock the lane.',
      longDescription: 'Run a fast signal check, confirm the approach is clear, and tag the area for your team before anyone else does.',
      scoring: {},
      portable: true,
    },
    {
      title: 'Field Sketch',
      shortDescription: 'Capture the space in three sharp notes.',
      longDescription: 'Make a quick field sketch of the zone in front of you: entry, sightline, and one landmark worth calling out to the team.',
      scoring: {},
      portable: true,
    },
    {
      title: 'Marker Drop',
      shortDescription: 'Plant a clean claim and hold it steady.',
      longDescription: 'Treat the current zone like a fresh checkpoint. Drop a marker, call the hold, and keep the team’s presence obvious.',
      scoring: {},
      portable: true,
    },
    {
      title: 'Route Audit',
      shortDescription: 'Check the approaches and secure the best line.',
      longDescription: 'Review the routes feeding into this zone and identify the strongest approach for your team to reinforce next.',
      scoring: {},
      portable: true,
    },
    {
      title: 'Civic Pulse',
      shortDescription: 'Read the zone and claim it with confidence.',
      longDescription: 'Take a quick read on how the zone feels on arrival, then convert that read into a decisive capture for your side.',
      scoring: {},
      portable: true,
    },
  ],
};

void runSampleSeed(config, { reuseExistingSeed: true }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
