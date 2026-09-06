import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { IDEMPOTENCY_KEY_HEADER, SESSION_COOKIE_NAME } from '@city-game/shared';
import type { DatabaseClient } from '../../db/connection.js';
import { challengeRerollVotes, challenges, games, players, teams } from '../../db/schema.js';
import { createTestApp } from '../../test/create-test-app.js';
import { createTestChallenge, createTestGame, createTestPlayer, createTestTeam } from '../../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../../test/test-db.js';
import { advanceChallengeRerollCharge } from './reroll-service.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ONE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_TWO_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const PLAYER_TWO_ID = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';
const ACTIVE_CHALLENGE_ID = '55555555-5555-4555-8555-555555555555';
const QUEUED_CHALLENGE_ID = '88888888-8888-4888-8888-888888888888';

describe('territory challenge rerolls', () => {
  let app: FastifyInstance;
  let testDatabase: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    testDatabase = await getTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('unlocks one shared charge after two completions without banking extra progress', async () => {
    await seedGame();
    await seedTeamAndPlayer();
    await seedChallenges();

    const first = await testDatabase.db.transaction((tx) => advanceChallengeRerollCharge(tx as unknown as DatabaseClient, {
      gameId: GAME_ID,
      completedChallengeId: ACTIVE_CHALLENGE_ID,
      settings: {},
    }));
    expect(first).toMatchObject({ isAvailable: false, completionProgress: 1, completionTarget: 2 });

    const second = await testDatabase.db.transaction((tx) => advanceChallengeRerollCharge(tx as unknown as DatabaseClient, {
      gameId: GAME_ID,
      completedChallengeId: ACTIVE_CHALLENGE_ID,
      settings: {},
    }));
    expect(second).toMatchObject({ isAvailable: true, completionProgress: 0, completionTarget: 2 });

    const third = await testDatabase.db.transaction((tx) => advanceChallengeRerollCharge(tx as unknown as DatabaseClient, {
      gameId: GAME_ID,
      completedChallengeId: ACTIVE_CHALLENGE_ID,
      settings: {},
    }));
    expect(third).toMatchObject({ isAvailable: true, completionProgress: 0 });
  });

  it('allows withdrawal, then rerolls only after every active team votes', async () => {
    await seedGame({ rerollAvailable: true });
    await seedTeamAndPlayer();
    await seedTeamAndPlayer({
      team: {
        id: TEAM_TWO_ID,
        name: 'Second Team',
        joinCode: 'TEAM5678',
        color: '#2563eb',
      },
      player: {
        id: PLAYER_TWO_ID,
        teamId: TEAM_TWO_ID,
        sessionToken: 'reroll-team-two',
        displayName: 'Player Two',
      },
    });
    await seedChallenges();
    app = await createTestApp({ db: testDatabase.db });

    const firstVote = await voteRequest('reroll-team-one', 'vote-one');
    expect(firstVote.statusCode).toBe(200);
    expect(firstVote.json()).toMatchObject({
      didReroll: false,
      rerollState: {
        isAvailable: true,
        eligibleTeamCount: 2,
        votes: [{ challengeId: ACTIVE_CHALLENGE_ID, teamIds: [TEAM_ONE_ID] }],
      },
    });

    const withdrawal = await voteRequest('reroll-team-one', 'withdraw-one');
    expect(withdrawal.statusCode).toBe(200);
    expect(withdrawal.json()).toMatchObject({
      didReroll: false,
      rerollState: { isAvailable: true, votes: [] },
    });

    await voteRequest('reroll-team-one', 'vote-one-again');
    const finalVote = await voteRequest('reroll-team-two', 'vote-two');
    expect(finalVote.statusCode).toBe(200);
    expect(finalVote.json()).toMatchObject({
      didReroll: true,
      challenge: { id: ACTIVE_CHALLENGE_ID, status: 'skipped', isDeckActive: false },
      activatedChallenge: { id: QUEUED_CHALLENGE_ID, status: 'available', isDeckActive: true },
      rerollState: { isAvailable: false, votes: [] },
    });

    const [storedGame] = await testDatabase.db.select().from(games).where(eq(games.id, GAME_ID));
    expect(storedGame?.rerollAvailable).toBe(false);
    const storedVotes = await testDatabase.db.select().from(challengeRerollVotes);
    expect(storedVotes).toHaveLength(0);
  });

  async function voteRequest(sessionToken: string, actionId: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/challenges/' + ACTIVE_CHALLENGE_ID + '/reroll-vote',
      headers: {
        cookie: SESSION_COOKIE_NAME + '=' + sessionToken,
        [IDEMPOTENCY_KEY_HEADER]: actionId,
      },
    });
  }

  async function seedGame(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(games).values(createTestGame({ status: 'active', ...overrides }));
  }

  async function seedTeamAndPlayer(input: {
    team?: Record<string, unknown>;
    player?: Record<string, unknown>;
  } = {}) {
    await testDatabase.db.insert(teams).values(createTestTeam(input.team));
    await testDatabase.db.insert(players).values(createTestPlayer({
      sessionToken: 'reroll-team-one',
      ...input.player,
    }));
  }

  async function seedChallenges() {
    await testDatabase.db.insert(challenges).values([
      createTestChallenge({
        id: ACTIVE_CHALLENGE_ID,
        zoneId: null,
        config: { portable: true },
        isDeckActive: true,
        sortOrder: 0,
      }),
      createTestChallenge({
        id: QUEUED_CHALLENGE_ID,
        zoneId: null,
        config: { portable: true },
        isDeckActive: false,
        sortOrder: 1,
      }),
    ]);
  }
});
