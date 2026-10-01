import type { GameSettings, WinConditions } from '@city-game/shared';
import { loadZoneFixture, runSampleSeed, type SampleSeedConfig, type ZoneSeed } from './seed-sample.js';

const gameSettings: GameSettings = {
  max_concurrent_claims: 2,
  claim_timeout_minutes: 10,
  require_gps_accuracy: false,
};

const winCondition: WinConditions = [
  { type: 'zone_majority', threshold: 0.6 },
  { type: 'time_limit', duration_minutes: 90 },
];

// Neighbourhood boundaries from the production map; see fixtures/toronto-zones.json.
const zoneOwners: Record<string, string> = {
  'Trinity-Bellwoods': 'Scarlet Team',
  'High Park-Swansea': 'Harbour Team',
  'Junction Area': 'Signal Team',
};

const zonePointValues: Record<string, number> = {
  'High Park-Swansea': 3,
  'Trinity-Bellwoods': 2,
  'Roncesvalles': 2,
};

const zones: ZoneSeed[] = loadZoneFixture('toronto-zones.json').map((zone) => ({
  name: zone.name,
  geometry: zone.geometry,
  ownerTeamName: zoneOwners[zone.name] ?? null,
  pointValue: zonePointValues[zone.name] ?? 1,
}));

const config: SampleSeedConfig = {
  seedKey: 'toronto_sample_v1',
  name: 'Toronto Territory Demo',
  mapName: 'Toronto Base Map',
  centerLat: 43.6888,
  centerLng: -79.446,
  defaultZoom: 12,
  settings: gameSettings,
  winCondition,
  teams: [
    { name: 'Scarlet Team', color: '#dc2626', joinCode: 'TORRED01' },
    { name: 'Harbour Team', color: '#2563eb', joinCode: 'TORBLUE1' },
    { name: 'Signal Team', color: '#d97706', joinCode: 'TORGOLD1' },
  ],
  zones,
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
