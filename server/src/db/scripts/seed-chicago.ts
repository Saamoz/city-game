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

// Neighbourhood boundaries from the production map; see fixtures/chicago-zones.json.
const zoneOwners: Record<string, string> = {
  'Loop': 'Lake Team',
  'West Loop': 'Ember Team',
  'River North': 'Crown Team',
};

const zonePointValues: Record<string, number> = {
  'Loop': 3,
  'Grant Park': 2,
  'River North': 2,
  'Magnificent Mile': 2,
  'West Loop': 2,
};

const zones: ZoneSeed[] = loadZoneFixture('chicago-zones.json').map((zone) => ({
  name: zone.name,
  geometry: zone.geometry,
  ownerTeamName: zoneOwners[zone.name] ?? null,
  pointValue: zonePointValues[zone.name] ?? 1,
}));

const config: SampleSeedConfig = {
  seedKey: 'chicago_sample_v1',
  name: 'Chicago Turf War Demo',
  mapName: 'Chicago Base Map',
  centerLat: 41.8895,
  centerLng: -87.6624,
  defaultZoom: 12,
  settings: gameSettings,
  winCondition,
  teams: [
    { name: 'Lake Team', color: '#2563eb', joinCode: 'CHIBLUE1' },
    { name: 'Ember Team', color: '#dc2626', joinCode: 'CHIRED01' },
    { name: 'Crown Team', color: '#d97706', joinCode: 'CHIGOLD1' },
  ],
  zones,
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
