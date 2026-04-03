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
      geometry: squarePolygon(-79.3871, 43.6426, 0.00115),
      ownerTeamName: 'Harbour Team',
      pointValue: 2,
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
      geometry: squarePolygon(-79.3801, 43.6389, 0.0012),
      pointValue: 3,
      metadata: { landmark: true },
    },
  ],
  challenges: [
    {
      title: 'Signal Sweep',
      shortDescription: 'Tag the zone and clear the approach.',
      longDescription: 'Sweep the immediate approach, confirm the route is workable, and lock the current zone down for your team.',
      scoring: {},
      portable: true,
    },
    {
      title: 'Street Read',
      shortDescription: 'Take a fast read on movement and rhythm.',
      longDescription: 'Read the flow through the zone, call the strongest angle, and turn that local advantage into a capture.',
      scoring: {},
      portable: true,
    },
    {
      title: 'Hold Marker',
      shortDescription: 'Establish presence and keep the line stable.',
      longDescription: 'Treat the zone as a live hold point. Stabilize the team position and make the capture feel deliberate.',
      scoring: {},
      portable: true,
    },
    {
      title: 'Route Proof',
      shortDescription: 'Confirm the best route out of the zone.',
      longDescription: 'Identify the strongest next route from this zone so the team can chain pressure into the surrounding blocks.',
      scoring: {},
      portable: true,
    },
    {
      title: 'Anchor Call',
      shortDescription: 'Plant the team flag in the current block.',
      longDescription: 'Make a clear anchor call from where you stand and convert that local control into a clean territory swing.',
      scoring: {},
      portable: true,
    },
  ],
};

void runSampleSeed(config, { clearExisting: true }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
