import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { SESSION_COOKIE_NAME } from '@city-game/shared';
import { challenges, games, players, resourceLedger, teams } from '../db/schema.js';
import { createTestApp } from '../test/create-test-app.js';
import { createTestChallenge, createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ONE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_TWO_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const PLAYER_TWO_ID = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';
const JUDGED_ID = '55555555-5555-4555-8555-555555555555';
const REGULAR_ID = '88888888-8888-4888-8888-888888888888';

describe('judged challenges', () => {
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

  it('lets each team submit once, keeps the challenge open, and scores nothing until judging is published', async () => {
    await seedPointGame();
    app = await createTestApp({ db: testDatabase.db });

    const first = await submit('team-one-session', 'judged-1', { note: 'Photo posted in the group chat' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ challenge: { id: JUDGED_ID, status: 'available' }, claim: { status: 'submitted', teamId: TEAM_ONE_ID, submission: null }, resourcesAwarded: {} });

    const repeat = await submit('team-one-session', 'judged-2', null);
    expect(repeat.statusCode).toBe(409);
    expect(repeat.json().error.message).toBe('Your team already submitted this challenge for judging.');

    const snapshot = await app.inject({ method: 'GET', url: '/api/v1/game/' + GAME_ID + '/map-state', cookies: { [SESSION_COOKIE_NAME]: 'team-two-session' } });
    const snapshotClaims = snapshot.json().claims ?? snapshot.json().snapshot?.claims;
    expect(snapshotClaims).toEqual([expect.objectContaining({ status: 'submitted', teamId: TEAM_ONE_ID, submission: null })]);

    const earlyPublish = await app.inject({ method: 'POST', url: '/api/v1/game/' + GAME_ID + '/judging/publish', headers: { 'idempotency-key': 'early-publish' } });
    expect(earlyPublish.statusCode).toBe(409);
    expect(await getGameStatus()).toBe('active');
    expect(await pointsFor(TEAM_ONE_ID)).toBe(0);
  });

  it('ends a point game once every team has submitted every judged challenge, then publishes and corrects judged scores', async () => {
    await seedPointGame();
    app = await createTestApp({ db: testDatabase.db });

    expect((await submit('team-one-session', 'judged-1', { note: 'Answer: 42' })).statusCode).toBe(200);
    expect((await submit('team-two-session', 'judged-2', null)).statusCode).toBe(200);
    await waitFor(async () => (await getGameStatus()) === 'completed');

    const sheetResponse = await app.inject({ method: 'GET', url: '/api/v1/game/' + GAME_ID + '/judging' });
    const sheet = sheetResponse.json().judging;
    expect(sheet.publishedAt).toBeNull();
    expect(sheet.challenges).toHaveLength(1);
    expect(sheet.challenges[0]).toMatchObject({ maxPoints: 10, challenge: { id: JUDGED_ID } });
    const submissions = sheet.challenges[0].submissions as Array<{ claimId: string; teamId: string; note: string | null }>;
    expect(submissions.map((entry) => [entry.teamId, entry.note])).toEqual([[TEAM_ONE_ID, 'Answer: 42'], [TEAM_TWO_ID, null]]);

    const claimFor = (teamId: string) => submissions.find((entry) => entry.teamId === teamId)!.claimId;
    await setPoints(claimFor(TEAM_ONE_ID), 7);
    await setPoints(claimFor(TEAM_TWO_ID), 3);
    expect(await pointsFor(TEAM_ONE_ID)).toBe(0);

    const recapBefore = await app.inject({ method: 'GET', url: '/api/v1/game/' + GAME_ID + '/public-recap' });
    expect(recapBefore.json().recap.judging).toMatchObject({ status: 'pending', submissionCount: 2 });

    const publish = await app.inject({ method: 'POST', url: '/api/v1/game/' + GAME_ID + '/judging/publish', headers: { 'idempotency-key': 'publish-1' } });
    expect(publish.statusCode).toBe(200);
    expect(await pointsFor(TEAM_ONE_ID)).toBe(7);
    expect(await pointsFor(TEAM_TWO_ID)).toBe(3);

    const recapAfter = await app.inject({ method: 'GET', url: '/api/v1/game/' + GAME_ID + '/public-recap' });
    expect(recapAfter.json().recap.judging.status).toBe('published');
    expect(recapAfter.json().recap.scoreboard[0]).toMatchObject({ team: { id: TEAM_ONE_ID }, rank: 1 });

    await setPoints(claimFor(TEAM_ONE_ID), 2);
    const republish = await app.inject({ method: 'POST', url: '/api/v1/game/' + GAME_ID + '/judging/publish', headers: { 'idempotency-key': 'publish-2' } });
    expect(republish.statusCode).toBe(200);
    expect(await pointsFor(TEAM_ONE_ID)).toBe(2);
    expect(await pointsFor(TEAM_TWO_ID)).toBe(3);
  });

  async function seedPointGame() {
    await testDatabase.db.insert(games).values(createTestGame({ status: 'active', modeKey: 'point_challenge', startedAt: new Date(Date.now() - 60_000) }));
    await testDatabase.db.insert(teams).values([
      createTestTeam({ id: TEAM_ONE_ID }),
      createTestTeam({ id: TEAM_TWO_ID, name: 'Other Team', color: '#2563eb', joinCode: 'TEAM9999' }),
    ]);
    await testDatabase.db.insert(players).values([
      createTestPlayer({ sessionToken: 'team-one-session' }),
      createTestPlayer({ id: PLAYER_TWO_ID, teamId: TEAM_TWO_ID, displayName: 'Player Two', sessionToken: 'team-two-session' }),
    ]);
    await testDatabase.db.insert(challenges).values([
      createTestChallenge({ id: JUDGED_ID, zoneId: null, isDeckActive: true, scoring: {}, config: { portable: true, location_mode: 'portable', judged: true, judged_max_points: 10 } }),
      createTestChallenge({ id: REGULAR_ID, zoneId: null, isDeckActive: false, status: 'completed', config: { portable: true, location_mode: 'portable' } }),
    ]);
  }

  function submit(sessionToken: string, actionId: string, submission: Record<string, unknown> | null) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/challenges/' + JUDGED_ID + '/complete',
      cookies: { [SESSION_COOKIE_NAME]: sessionToken },
      headers: { 'idempotency-key': actionId },
      payload: { submission, gps: null },
    });
  }

  async function setPoints(claimId: string, points: number) {
    const response = await app.inject({ method: 'PUT', url: '/api/v1/judging/submissions/' + claimId, headers: { 'idempotency-key': 'points-' + claimId + '-' + points }, payload: { points } });
    expect(response.statusCode).toBe(200);
  }

  async function getGameStatus() {
    const [game] = await testDatabase.db.select({ status: games.status }).from(games).where(eq(games.id, GAME_ID));
    return game?.status;
  }

  async function pointsFor(teamId: string) {
    const [row] = await testDatabase.db.select({ total: sql<number>`COALESCE(SUM(${resourceLedger.delta}), 0)::int` }).from(resourceLedger)
      .where(and(eq(resourceLedger.gameId, GAME_ID), eq(resourceLedger.teamId, teamId), eq(resourceLedger.resourceType, 'points')));
    return Number(row?.total ?? 0);
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for condition.');
  }
});
