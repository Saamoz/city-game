import type { GameSettings, WinConditions } from '@city-game/shared';
import { runSampleSeed, squarePolygon, type SampleSeedConfig } from './seed-sample.js';

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
      geometry: squarePolygon(-87.6401, 41.8786, 0.00115),
      ownerTeamName: 'Ember Team',
      pointValue: 2,
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
      geometry: squarePolygon(-87.6079, 41.8917, 0.0012),
      pointValue: 3,
      metadata: { landmark: true },
    },
  ],
  challenges: [
    {
      title: 'Crosswind Check',
      shortDescription: 'Secure the zone and verify the angle.',
      longDescription: 'Check the current angle into the zone, confirm it holds, and convert that read into a fast capture.',
      scoring: {},
      portable: true,
    },
    {
      title: 'Grid Survey',
      shortDescription: 'Read the block and plant your hold.',
      longDescription: 'Survey the local block pattern, choose the cleanest hold position, and seal the zone before the rival team rotates in.',
      scoring: {},
      portable: true,
    },
    {
      title: 'Anchor Sweep',
      shortDescription: 'Sweep the perimeter and anchor the center.',
      longDescription: 'Treat the current zone as a live anchor point. Sweep the edge, claim the center, and make the capture stick.',
      scoring: {},
      portable: true,
    },
    {
      title: 'Approach Audit',
      shortDescription: 'Confirm the strongest entry line.',
      longDescription: 'Audit the strongest entry into this zone so the team can either reinforce it or rotate through it immediately after capture.',
      scoring: {},
      portable: true,
    },
    {
      title: 'Signal Lock',
      shortDescription: 'Lock the zone and call the claim cleanly.',
      longDescription: 'Make the capture feel deliberate: identify the zone, confirm the hold, and lock the signal for your team.',
      scoring: {},
      portable: true,
    },
  ],
};

void runSampleSeed(config, { clearExisting: true }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
