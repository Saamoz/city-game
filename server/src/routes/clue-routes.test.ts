import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME } from '@city-game/shared';
import { challenges, challengeSetItems, challengeSets, clueImages, clueImageTiles, games, players, teams } from '../db/schema.js';
import { createTestApp } from '../test/create-test-app.js';
import { createTestChallenge, createTestGame, createTestPlayer, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ONE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_TWO_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const PLAYER_TWO_ID = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';
const IMAGE_ID = 'cccccccc-4444-4444-8444-cccccccccccc';
const FIRST_ID = '55555555-5555-4555-8555-555555555555';
const SECOND_ID = '66666666-6666-4666-8666-666666666666';
const JUDGED_ID = '77777777-7777-4777-8777-777777777777';
const SET_ID = 'dddddddd-5555-4555-8555-dddddddddddd';
const SEEDED_FRAGMENT_COUNT = 27;

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = 'data:image/png;base64,' + PNG_BASE64;

describe('clue fragments', () => {
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

  it('takes pictures cut for the set before the game, picks one in secret at the start, and then locks them', async () => {
    await testDatabase.db.insert(challengeSets).values({ id: SET_ID, name: 'Clue Set', metadata: { locationMode: 'point' } });
    await testDatabase.db.insert(challengeSetItems).values(['One', 'Two', 'Three'].map((title, sortOrder) => ({ setId: SET_ID, title, description: title, kind: 'standard', sortOrder })));
    await testDatabase.db.insert(games).values(createTestGame({ modeKey: 'point_challenge', challengeSetId: SET_ID }));
    await testDatabase.db.insert(teams).values(createTestTeam());
    app = await createTestApp({ db: testDatabase.db });

    // One fragment per challenge in the set.
    expect((await upload('upload-wrong-count', 27)).statusCode).toBe(400);
    expect((await upload('upload-1', 3)).statusCode).toBe(201);
    expect((await upload('upload-2', 3)).statusCode).toBe(201);
    const badUpload = await app.inject({ method: 'POST', url: `/api/v1/game/${GAME_ID}/clue/images`, headers: { 'idempotency-key': 'upload-bad' }, payload: { width: 30, height: 20, thumbnail: PNG_DATA_URL, tiles: Array(3).fill('not-a-picture') } });
    expect(badUpload.statusCode).toBe(400);

    const before = (await adminStatus()).json().clue;
    expect(before).toMatchObject({ fragmentCount: 3, isChosen: false, foundFragmentCount: 0, revealedAt: null });
    expect(before.images).toHaveLength(2);
    expect(before.images[0].fragmentCount).toBe(3);

    const start = await app.inject({ method: 'POST', url: `/api/v1/game/${GAME_ID}/start`, headers: { 'idempotency-key': 'start-1' } });
    expect(start.statusCode).toBe(200);
    const selected = await testDatabase.db.select().from(clueImages).where(eq(clueImages.isSelected, true));
    expect(selected).toHaveLength(1);

    const after = (await adminStatus()).json().clue;
    expect(after.isChosen).toBe(true);
    // Nothing the admin sees says which picture was picked.
    expect(JSON.stringify(after)).not.toContain('elected');
    expect(after.images.map((image: { id: string }) => image.id)).toEqual(before.images.map((image: { id: string }) => image.id));

    expect((await upload('upload-3', 3)).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/clue/images/${selected[0]!.id}`, headers: { 'idempotency-key': 'delete-1' } })).statusCode).toBe(400);
  });

  it('gives each completed challenge its own fragment, visible only to the teams that completed it until revealed', async () => {
    await seedActiveGame();
    app = await createTestApp({ db: testDatabase.db });

    expect((await clueFor('team-one-session')).json().clue).toMatchObject({ width: 30, height: 20, fragmentCount: SEEDED_FRAGMENT_COUNT, revealedAt: null, fragments: [] });

    expect((await complete(FIRST_ID, 'team-one-session', 'first')).statusCode).toBe(200);
    const teamOneClue = (await clueFor('team-one-session')).json().clue;
    expect(teamOneClue.fragments).toEqual([expect.objectContaining({ challengeTitle: 'First', teamIds: [TEAM_ONE_ID] })]);
    const firstIndex = teamOneClue.fragments[0].index as number;
    expect((await clueFor('team-two-session')).json().clue.fragments).toEqual([]);

    const tile = await fragment(firstIndex, 'team-one-session');
    expect(tile.statusCode).toBe(200);
    expect(tile.headers['content-type']).toBe('image/png');
    expect(tile.rawPayload.equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);
    expect((await fragment(firstIndex, 'team-two-session')).statusCode).toBe(404);

    // Both teams submit the judged challenge: they share its fragment.
    expect((await complete(JUDGED_ID, 'team-one-session', 'judged-1')).statusCode).toBe(200);
    expect((await complete(JUDGED_ID, 'team-two-session', 'judged-2')).statusCode).toBe(200);
    expect((await complete(SECOND_ID, 'team-two-session', 'second')).statusCode).toBe(200);

    const teamTwoClue = (await clueFor('team-two-session')).json().clue;
    expect(teamTwoClue.fragments.map((entry: { challengeTitle: string }) => entry.challengeTitle).sort()).toEqual(['Judged', 'Second']);
    expect(teamTwoClue.fragments.every((entry: { teamIds: string[] }) => entry.teamIds.length === 1 && entry.teamIds[0] === TEAM_TWO_ID)).toBe(true);

    const assigned = await testDatabase.db.select({ index: challenges.clueFragmentIndex }).from(challenges).where(eq(challenges.gameId, GAME_ID));
    const indexes = assigned.map((row) => row.index);
    expect(indexes.every((index) => index !== null && index >= 0 && index < SEEDED_FRAGMENT_COUNT)).toBe(true);
    expect(new Set(indexes).size).toBe(3);

    const reveal = await app.inject({ method: 'POST', url: `/api/v1/game/${GAME_ID}/clue/reveal`, headers: { 'idempotency-key': 'reveal-1' }, payload: { revealed: true } });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json().game.clueRevealedAt).toEqual(expect.any(String));

    const revealed = (await clueFor('team-two-session')).json().clue;
    expect(revealed.revealedAt).toEqual(expect.any(String));
    expect(revealed.fragments).toHaveLength(3);
    const judged = revealed.fragments.find((entry: { challengeTitle: string }) => entry.challengeTitle === 'Judged');
    expect(judged.teamIds).toEqual([TEAM_ONE_ID, TEAM_TWO_ID]);
    expect((await fragment(firstIndex, 'team-two-session')).statusCode).toBe(200);
    expect((await adminStatus()).json().clue).toMatchObject({ isChosen: true, foundFragmentCount: 3 });

    const hide = await app.inject({ method: 'POST', url: `/api/v1/game/${GAME_ID}/clue/reveal`, headers: { 'idempotency-key': 'hide-1' }, payload: { revealed: false } });
    expect(hide.statusCode).toBe(200);
    expect((await fragment(firstIndex, 'team-two-session')).statusCode).toBe(404);
  });

  it('takes no pictures for a game without a challenge set', async () => {
    await testDatabase.db.insert(games).values(createTestGame({ modeKey: 'point_challenge' }));
    app = await createTestApp({ db: testDatabase.db });

    expect((await adminStatus()).json().clue.fragmentCount).toBeNull();
    const response = await upload('upload-1', 27);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/challenge set/);
  });

  it('has no clue when no pictures were added', async () => {
    await seedActiveGame({ withImage: false });
    app = await createTestApp({ db: testDatabase.db });

    expect((await complete(FIRST_ID, 'team-one-session', 'first')).statusCode).toBe(200);
    expect((await clueFor('team-one-session')).json().clue).toBeNull();
    const [row] = await testDatabase.db.select({ index: challenges.clueFragmentIndex }).from(challenges).where(eq(challenges.id, FIRST_ID));
    expect(row?.index).toBeNull();
  });

  function upload(actionId: string, fragmentCount: number) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/game/${GAME_ID}/clue/images`,
      headers: { 'idempotency-key': actionId },
      payload: { width: 30, height: 20, thumbnail: PNG_DATA_URL, tiles: Array(fragmentCount).fill(PNG_DATA_URL) },
    });
  }

  function adminStatus() {
    return app.inject({ method: 'GET', url: `/api/v1/game/${GAME_ID}/clue/admin` });
  }

  function clueFor(sessionToken: string) {
    return app.inject({ method: 'GET', url: `/api/v1/game/${GAME_ID}/clue`, cookies: { [SESSION_COOKIE_NAME]: sessionToken } });
  }

  function fragment(index: number, sessionToken: string) {
    return app.inject({ method: 'GET', url: `/api/v1/game/${GAME_ID}/clue/fragments/${index}`, cookies: { [SESSION_COOKIE_NAME]: sessionToken } });
  }

  function complete(challengeId: string, sessionToken: string, actionId: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/challenges/' + challengeId + '/complete',
      cookies: { [SESSION_COOKIE_NAME]: sessionToken },
      headers: { 'idempotency-key': actionId },
      payload: { submission: null, gps: null },
    });
  }

  async function seedActiveGame({ withImage = true } = {}) {
    await testDatabase.db.insert(games).values(createTestGame({ status: 'active', modeKey: 'point_challenge', startedAt: new Date(Date.now() - 60_000) }));
    await testDatabase.db.insert(teams).values([
      createTestTeam({ id: TEAM_ONE_ID }),
      createTestTeam({ id: TEAM_TWO_ID, name: 'Other Team', color: '#2563eb', joinCode: 'TEAM9999' }),
    ]);
    await testDatabase.db.insert(players).values([
      createTestPlayer({ sessionToken: 'team-one-session' }),
      createTestPlayer({ id: PLAYER_TWO_ID, teamId: TEAM_TWO_ID, displayName: 'Player Two', sessionToken: 'team-two-session' }),
    ]);
    const portable = { portable: true, location_mode: 'portable' };
    await testDatabase.db.insert(challenges).values([
      createTestChallenge({ id: FIRST_ID, title: 'First', zoneId: null, isDeckActive: true, sortOrder: 0, config: portable }),
      createTestChallenge({ id: SECOND_ID, title: 'Second', zoneId: null, isDeckActive: true, sortOrder: 1, config: portable }),
      createTestChallenge({ id: JUDGED_ID, title: 'Judged', zoneId: null, isDeckActive: true, sortOrder: 2, scoring: {}, config: { ...portable, judged: true, judged_max_points: 1 } }),
    ]);
    if (withImage) {
      await testDatabase.db.insert(clueImages).values({ id: IMAGE_ID, gameId: GAME_ID, width: 30, height: 20, fragmentCount: SEEDED_FRAGMENT_COUNT, thumbnail: PNG_DATA_URL, isSelected: true });
      await testDatabase.db.insert(clueImageTiles).values(Array.from({ length: SEEDED_FRAGMENT_COUNT }, (_, tileIndex) => ({ imageId: IMAGE_ID, tileIndex, contentType: 'image/png', data: PNG_BASE64 })));
    }
  }
});
