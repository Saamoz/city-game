import { generateSessionToken } from '../lib/auth.js';

export function createTestGame(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Test Game',
    modeKey: 'territory',
    city: 'Winnipeg',
    centerLat: '49.8951',
    centerLng: '-97.1384',
    defaultZoom: 13,
    winCondition: [],
    settings: {},
    ...overrides,
  };
}

export function createTestTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    gameId: '11111111-1111-4111-8111-111111111111',
    name: 'Test Team',
    color: '#ea580c',
    joinCode: 'TEAM1234',
    metadata: {},
    ...overrides,
  };
}

export function createTestPlayer(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    gameId: '11111111-1111-4111-8111-111111111111',
    teamId: '22222222-2222-4222-8222-222222222222',
    displayName: 'Player One',
    sessionToken: generateSessionToken(),
    metadata: {},
    ...overrides,
  };
}

export function createTestZone(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    gameId: '11111111-1111-4111-8111-111111111111',
    name: 'Test Zone',
    pointValue: 1,
    isDisabled: false,
    metadata: {},
    ...overrides,
  };
}

export function createTestChallenge(overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    gameId: '11111111-1111-4111-8111-111111111111',
    zoneId: '44444444-4444-4444-8444-444444444444',
    title: 'Test Challenge',
    description: 'Complete the test challenge.',
    kind: 'visit',
    config: {},
    completionMode: 'self_report',
    scoring: { points: 10 },
    status: 'available',
    ...overrides,
  };
}
