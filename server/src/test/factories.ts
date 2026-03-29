export function createTestGame(overrides: Record<string, unknown> = {}) {
  return {
    id: 'game-test-id',
    name: 'Test Game',
    modeKey: 'territory',
    ...overrides,
  };
}

export function createTestTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: 'team-test-id',
    gameId: 'game-test-id',
    name: 'Test Team',
    color: '#ea580c',
    ...overrides,
  };
}

export function createTestPlayer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'player-test-id',
    gameId: 'game-test-id',
    teamId: 'team-test-id',
    displayName: 'Player One',
    ...overrides,
  };
}

export function createTestZone(overrides: Record<string, unknown> = {}) {
  return {
    id: 'zone-test-id',
    gameId: 'game-test-id',
    name: 'Test Zone',
    ...overrides,
  };
}

export function createTestChallenge(overrides: Record<string, unknown> = {}) {
  return {
    id: 'challenge-test-id',
    gameId: 'game-test-id',
    zoneId: 'zone-test-id',
    title: 'Test Challenge',
    kind: 'visit',
    ...overrides,
  };
}
