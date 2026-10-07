import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { SESSION_COOKIE_NAME, STATE_VERSION_HEADER, eventTypes } from '@city-game/shared';
import {
  challengeClaims,
  challenges,
  gameEvents,
  games,
  players,
  resourceLedger,
  teams,
  zones,
} from '../../db/schema.js';
import { createZone } from '../../services/spatial-service.js';
import type { NotificationService, TeamNotificationInput } from '../../services/notification-service.js';
import { createTestApp } from '../../test/create-test-app.js';
import { createTestChallenge, createTestGame, createTestPlayer, createTestTeam } from '../../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../../test/test-db.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ONE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_TWO_ID = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const PLAYER_ONE_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_TWO_ID = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';
const CHALLENGE_ID = '55555555-5555-4555-8555-555555555555';
const CLAIM_ID = '77777777-7777-4777-8777-777777777777';
const NEXT_CHALLENGE_ID = '88888888-8888-4888-8888-888888888888';
const OUTSIDE_GAME_ID = '99999999-1111-4111-8111-999999999999';
const OUTSIDE_GAME_TEAM_ID = '99999999-2222-4222-8222-999999999999';

const ZONE_GEOMETRY = {
  type: 'Polygon',
  coordinates: [[
    [-97.1405, 49.8944],
    [-97.1363, 49.8944],
    [-97.1363, 49.8962],
    [-97.1405, 49.8962],
    [-97.1405, 49.8944],
  ]],
} as unknown as import('@city-game/shared').GeoJsonPolygon;

// East neighbour of ZONE_GEOMETRY (runtime zones must be connected); the
// default GPS fix is ~150 m from it, well outside its claim buffer.
const TARGET_ZONE_GEOMETRY = {
  type: 'Polygon',
  coordinates: [[
    [-97.1363, 49.8944],
    [-97.1321, 49.8944],
    [-97.1321, 49.8962],
    [-97.1363, 49.8962],
    [-97.1363, 49.8944],
  ]],
} as unknown as import('@city-game/shared').GeoJsonPolygon;

describe('territory complete route', () => {
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

  it('completes an active claim, captures the zone, awards resources, and logs one state version', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'complete-success-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id, scoring: { points: 10, coins: 2, energy: 3 } });
    await seedClaimedChallenge({ expiresAt: new Date(Date.now() + 5 * 60_000) });
    app = await createTestApp({ db: testDatabase.db });

    const response = await completeRequest({
      sessionToken: 'complete-success-session',
      actionId: 'complete-success',
      payload: {
        submission: {
          proof: 'photo-123',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers[STATE_VERSION_HEADER.toLowerCase()]).toBe('1');
    expect(response.json()).toMatchObject({
      stateVersion: 1,
      challenge: {
        id: CHALLENGE_ID,
        status: 'completed',
        currentClaimId: null,
      },
      claim: {
        id: CLAIM_ID,
        status: 'completed',
        teamId: TEAM_ONE_ID,
      },
      zone: {
        id: zone.id,
        ownerTeamId: TEAM_ONE_ID,
      },
      resourcesAwarded: {
        points: 10,
        coins: 2,
        energy: 3,
      },
    });

    const [storedGame] = await testDatabase.db
      .select({ stateVersion: games.stateVersion })
      .from(games)
      .where(eq(games.id, GAME_ID));
    expect(storedGame?.stateVersion).toBe(1);

    const [storedChallenge] = await testDatabase.db.select().from(challenges).where(eq(challenges.id, CHALLENGE_ID));
    expect(storedChallenge?.status).toBe('completed');
    expect(storedChallenge?.currentClaimId).toBeNull();
    expect(storedChallenge?.expiresAt).toBeNull();

    const [storedClaim] = await testDatabase.db.select().from(challengeClaims).where(eq(challengeClaims.id, CLAIM_ID));
    expect(storedClaim?.status).toBe('completed');
    expect(storedClaim?.completedAt).toBeInstanceOf(Date);
    expect(storedClaim?.submission).toEqual({ proof: 'photo-123' });

    const [storedZone] = await testDatabase.db
      .select({ ownerTeamId: zones.ownerTeamId, capturedAt: zones.capturedAt })
      .from(zones)
      .where(eq(zones.id, zone.id));
    expect(storedZone?.ownerTeamId).toBe(TEAM_ONE_ID);
    expect(storedZone?.capturedAt).toBeInstanceOf(Date);

    const ledgerRows = await testDatabase.db
      .select({
        resourceType: resourceLedger.resourceType,
        delta: resourceLedger.delta,
        balanceAfter: resourceLedger.balanceAfter,
        reason: resourceLedger.reason,
      })
      .from(resourceLedger)
      .where(eq(resourceLedger.gameId, GAME_ID))
      .orderBy(asc(resourceLedger.sequence));
    expect([...ledgerRows].sort((left, right) => left.resourceType.localeCompare(right.resourceType))).toEqual([
      {
        resourceType: 'coins',
        delta: 2,
        balanceAfter: 2,
        reason: 'challenge_completed',
      },
      {
        resourceType: 'energy',
        delta: 3,
        balanceAfter: 3,
        reason: 'challenge_completed',
      },
      {
        resourceType: 'points',
        delta: 10,
        balanceAfter: 10,
        reason: 'challenge_completed',
      },
    ]);

    const storedEvents = await testDatabase.db
      .select({ eventType: gameEvents.eventType, stateVersion: gameEvents.stateVersion })
      .from(gameEvents)
      .where(eq(gameEvents.gameId, GAME_ID))
      .orderBy(asc(gameEvents.createdAt));

    expect(storedEvents).toHaveLength(7);
    expect(storedEvents.map((event) => event.stateVersion)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(storedEvents.map((event) => event.eventType).sort()).toEqual([
      eventTypes.objectiveStateChanged,
      eventTypes.controlStateChanged,
      eventTypes.resourceChanged,
      eventTypes.resourceChanged,
      eventTypes.resourceChanged,
      eventTypes.challengeCompleted,
      eventTypes.zoneCaptured,
    ].sort());
  });


  it('activates the next queued challenge in the same completion transaction', async () => {
    await seedGame({ settings: { active_challenge_count: 1, challenge_total_count: 2 } });
    await seedTeam();
    await seedPlayer({ sessionToken: 'complete-promote-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id, sortOrder: 0, isDeckActive: true, scoring: { points: 4 } });
    await testDatabase.db.insert(challenges).values(createTestChallenge({
      id: NEXT_CHALLENGE_ID,
      gameId: GAME_ID,
      zoneId: null,
      title: 'Next Challenge',
      description: 'Promoted after completion.',
      sortOrder: 1,
      isDeckActive: false,
      status: 'available',
      scoring: { points: 6 },
    }));
    await seedClaimedChallenge({ expiresAt: new Date(Date.now() + 5 * 60_000) });
    app = await createTestApp({ db: testDatabase.db });

    const response = await completeRequest({
      sessionToken: 'complete-promote-session',
      actionId: 'complete-promote',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      stateVersion: 1,
      activatedChallenge: {
        id: NEXT_CHALLENGE_ID,
        status: 'available',
        isDeckActive: true,
        sortOrder: 1,
      },
    });

    const [storedNextChallenge] = await testDatabase.db
      .select()
      .from(challenges)
      .where(eq(challenges.id, NEXT_CHALLENGE_ID));

    expect(storedNextChallenge?.isDeckActive).toBe(true);
    expect(storedNextChallenge?.status).toBe('available');

    const storedEvents = await testDatabase.db
      .select({ eventType: gameEvents.eventType, stateVersion: gameEvents.stateVersion })
      .from(gameEvents)
      .where(eq(gameEvents.gameId, GAME_ID))
      .orderBy(asc(gameEvents.createdAt));

    expect(storedEvents.every((event) => event.stateVersion === 1)).toBe(true);
    expect(storedEvents.map((event) => event.eventType)).toContain(eventTypes.challengeSpawned);
  });

  it('completes a point-linked challenge inside its radius and captures the containing zone', async () => {
    await seedGame(); await seedTeam(); await seedPlayer({ sessionToken: 'point-complete-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: null, config: { portable: false, location_mode: 'point', source_map_point: { type: 'Point', coordinates: [-97.1384, 49.8951] }, point_radius_meters: 25 }, scoring: { points: 5 } });
    app = await createTestApp({ db: testDatabase.db });
    const response = await completeRequest({ sessionToken: 'point-complete-session', actionId: 'point-complete', payload: { gps: validGpsPayload() } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ challenge: { status: 'completed', zoneId: zone.id }, claim: { status: 'completed' }, zone: { id: zone.id, ownerTeamId: TEAM_ONE_ID }, resourcesAwarded: { points: 5 } });
  });

  it('scores a point challenge without creating or capturing zones in point-challenge mode', async () => {
    await seedGame({ modeKey: 'point_challenge' }); await seedTeam(); await seedPlayer({ sessionToken: 'point-mode-session' });
    await seedChallenge({ zoneId: null, config: { portable: false, location_mode: 'point', source_map_point: { type: 'Point', coordinates: [-97.1384, 49.8951] }, point_radius_meters: 25 }, scoring: { points: 8 } });
    app = await createTestApp({ db: testDatabase.db });
    const response = await completeRequest({ sessionToken: 'point-mode-session', actionId: 'point-mode-complete', payload: { gps: validGpsPayload() } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ challenge: { status: 'completed', zoneId: null }, zone: null, resourcesAwarded: { points: 8 } });
    expect(await testDatabase.db.select().from(zones).where(eq(zones.gameId, GAME_ID))).toHaveLength(0);
  });

  it('completes an anywhere challenge in point-challenge mode without zones and deals the next card', async () => {
    await seedGame({ modeKey: 'point_challenge' }); await seedTeam(); await seedPlayer({ sessionToken: 'anywhere-session' });
    await seedChallenge({ zoneId: null, isDeckActive: true, config: { portable: true, location_mode: 'portable', location_hint: 'Any cafe' }, scoring: { points: 3 } });
    await testDatabase.db.insert(challenges).values(createTestChallenge({ id: NEXT_CHALLENGE_ID, gameId: GAME_ID, zoneId: null, isDeckActive: false, sortOrder: 1, config: { portable: true, location_mode: 'portable' } }));
    app = await createTestApp({ db: testDatabase.db });
    const response = await completeRequest({ sessionToken: 'anywhere-session', actionId: 'anywhere-complete', payload: { gps: validGpsPayload() } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ challenge: { status: 'completed', zoneId: null }, zone: null, resourcesAwarded: { points: 3 }, activatedChallenge: { id: NEXT_CHALLENGE_ID } });
  });

  it('completes an anywhere challenge with no GPS fix in point-challenge mode', async () => {
    await seedGame({ modeKey: 'point_challenge' }); await seedTeam(); await seedPlayer({ sessionToken: 'anywhere-nogps-session' });
    await seedChallenge({ zoneId: null, isDeckActive: true, config: { portable: true, location_mode: 'portable' }, scoring: { points: 2 } });
    app = await createTestApp({ db: testDatabase.db });
    const response = await completeRequest({ sessionToken: 'anywhere-nogps-session', actionId: 'anywhere-nogps', payload: { gps: null } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ challenge: { status: 'completed' }, claim: { locationAtClaim: null }, resourcesAwarded: { points: 2 } });
  });

  it('adds self-reported bonus points to the base award, ignoring bonuses the challenge does not have', async () => {
    await seedGame({ modeKey: 'point_challenge' }); await seedTeam(); await seedPlayer({ sessionToken: 'bonus-session' });
    await seedChallenge({ zoneId: null, isDeckActive: true, scoring: { points: 3 }, config: { portable: true, location_mode: 'portable', bonuses: [{ id: 'b-hat', label: 'Wear a hat', points: 2 }, { id: 'b-song', label: 'Sing it', points: 5 }] } });
    app = await createTestApp({ db: testDatabase.db });
    const response = await completeRequest({ sessionToken: 'bonus-session', actionId: 'bonus-complete', payload: { gps: null, submission: { bonusIds: ['b-hat', 'b-unknown'] } } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ resourcesAwarded: { points: 5 }, claim: { submission: { bonusIds: ['b-hat', 'b-unknown'] } } });
    const [ledger] = await testDatabase.db.select().from(resourceLedger).where(eq(resourceLedger.gameId, GAME_ID));
    expect(ledger).toMatchObject({ teamId: TEAM_ONE_ID, resourceType: 'points', delta: 5 });
  });

  it('awards the default 1 point when a challenge has no points set', async () => {
    await seedGame({ modeKey: 'point_challenge' }); await seedTeam(); await seedPlayer({ sessionToken: 'default-points-session' });
    await seedChallenge({ zoneId: null, isDeckActive: true, scoring: {}, config: { portable: true, location_mode: 'portable' } });
    app = await createTestApp({ db: testDatabase.db });
    const response = await completeRequest({ sessionToken: 'default-points-session', actionId: 'default-points', payload: { gps: null } });
    expect(response.statusCode).toBe(200);
    expect(response.json().resourcesAwarded).toEqual({ points: 1 });
  });

  it('completes an area challenge from inside its drawn area and rejects it from outside', async () => {
    const square = (west: number, south: number, size: number) => ({ type: 'Polygon', coordinates: [[[west, south], [west + size, south], [west + size, south + size], [west, south + size], [west, south]]] });
    await seedGame({ modeKey: 'point_challenge' }); await seedTeam(); await seedPlayer({ sessionToken: 'area-session' });
    await seedChallenge({ zoneId: null, isDeckActive: true, scoring: { points: 3 }, config: { portable: false, location_mode: 'area', area: square(-97.1400, 49.8940, 0.003) } });
    await testDatabase.db.insert(challenges).values(createTestChallenge({ id: NEXT_CHALLENGE_ID, gameId: GAME_ID, zoneId: null, isDeckActive: true, config: { portable: false, location_mode: 'area', area: square(-97.1000, 49.9000, 0.002) } }));
    app = await createTestApp({ db: testDatabase.db });

    const inside = await completeRequest({ sessionToken: 'area-session', actionId: 'area-inside', payload: { gps: validGpsPayload() } });
    expect(inside.statusCode).toBe(200);
    expect(inside.json()).toMatchObject({ challenge: { status: 'completed', zoneId: null }, resourcesAwarded: { points: 3 }, activatedChallenge: null });

    const outside = await app.inject({ method: 'POST', url: '/api/v1/challenges/' + NEXT_CHALLENGE_ID + '/complete', cookies: { [SESSION_COOKIE_NAME]: 'area-session' }, headers: { 'idempotency-key': 'area-outside' }, payload: { gps: validGpsPayload() } });
    expect(outside.statusCode).toBe(422);
    expect(outside.json()).toMatchObject({ error: { code: 'OUTSIDE_ZONE', message: 'Head into the challenge area to complete this.' } });
  });

  it('does not deal an extra deck card when a pinned point challenge is completed', async () => {
    await seedGame({ modeKey: 'point_challenge' }); await seedTeam(); await seedPlayer({ sessionToken: 'pin-deck-session' });
    await seedChallenge({ zoneId: null, isDeckActive: true, config: { portable: false, location_mode: 'point', source_map_point: { type: 'Point', coordinates: [-97.1384, 49.8951] }, point_radius_meters: 25 } });
    await testDatabase.db.insert(challenges).values(createTestChallenge({ id: NEXT_CHALLENGE_ID, gameId: GAME_ID, zoneId: null, isDeckActive: false, sortOrder: 1, config: { portable: true, location_mode: 'portable' } }));
    app = await createTestApp({ db: testDatabase.db });
    const response = await completeRequest({ sessionToken: 'pin-deck-session', actionId: 'pin-deck-complete', payload: { gps: validGpsPayload() } });
    expect(response.statusCode).toBe(200);
    expect(response.json().activatedChallenge).toBeNull();
  });

  it('rejects a point-linked challenge outside its configured radius', async () => {
    await seedGame(); await seedTeam(); await seedPlayer({ sessionToken: 'point-far-session' }); await seedZone();
    await seedChallenge({ zoneId: null, config: { portable: false, location_mode: 'point', source_map_point: { type: 'Point', coordinates: [-97.12, 49.905] }, point_radius_meters: 20 } });
    app = await createTestApp({ db: testDatabase.db });
    const response = await completeRequest({ sessionToken: 'point-far-session', actionId: 'point-far', payload: { gps: validGpsPayload() } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'OUTSIDE_ZONE', message: 'Move closer to this challenge location.', details: { challengeId: CHALLENGE_ID, radiusMeters: 20 } } });
    expect(response.json().error.details.distanceMeters).toBeGreaterThan(20);
  });

  it('completes a portable card directly from the current zone without creating a visible claimed state', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'portable-complete-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: null, config: { portable: true }, scoring: { points: 7 } });
    app = await createTestApp({ db: testDatabase.db });

    const response = await completeRequest({
      sessionToken: 'portable-complete-session',
      actionId: 'portable-complete',
      payload: {
        gps: validGpsPayload(),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      challenge: {
        id: CHALLENGE_ID,
        status: 'completed',
        zoneId: zone.id,
      },
      claim: {
        teamId: TEAM_ONE_ID,
        playerId: PLAYER_ONE_ID,
        status: 'completed',
      },
      zone: {
        id: zone.id,
        ownerTeamId: TEAM_ONE_ID,
      },
      resourcesAwarded: {
        points: 7,
      },
    });

    const storedClaims = await testDatabase.db.select().from(challengeClaims).where(eq(challengeClaims.challengeId, CHALLENGE_ID));
    expect(storedClaims).toHaveLength(1);
    expect(storedClaims[0]?.status).toBe('completed');
    expect(storedClaims[0]?.completedAt).toBeInstanceOf(Date);

    const storedEvents = await testDatabase.db
      .select({ eventType: gameEvents.eventType })
      .from(gameEvents)
      .where(eq(gameEvents.gameId, GAME_ID))
      .orderBy(asc(gameEvents.createdAt));

    expect(storedEvents.map((event) => event.eventType).sort()).toEqual([
      eventTypes.objectiveStateChanged,
      eventTypes.controlStateChanged,
      eventTypes.resourceChanged,
      eventTypes.challengeCompleted,
      eventTypes.zoneCaptured,
    ].sort());
  });

  it('completes a portable card for a selected zone even when current GPS is in another zone', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'portable-target-zone-session' });
    const currentZone = await seedZone();
    const targetZone = await createZone(testDatabase.db, {
      gameId: GAME_ID,
      name: 'Started Zone',
      geometry: TARGET_ZONE_GEOMETRY,
      pointValue: 1,
    });
    await seedChallenge({ zoneId: null, config: { portable: true }, scoring: { points: 7 } });
    app = await createTestApp({ db: testDatabase.db });

    const response = await completeRequest({
      sessionToken: 'portable-target-zone-session',
      actionId: 'portable-target-zone',
      payload: {
        gps: validGpsPayload(),
        targetZoneId: targetZone.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      challenge: {
        id: CHALLENGE_ID,
        status: 'completed',
        zoneId: targetZone.id,
      },
      zone: {
        id: targetZone.id,
        ownerTeamId: TEAM_ONE_ID,
      },
    });

    const [storedCurrentZone] = await testDatabase.db.select().from(zones).where(eq(zones.id, currentZone.id)).limit(1);
    const [storedTargetZone] = await testDatabase.db.select().from(zones).where(eq(zones.id, targetZone.id)).limit(1);
    expect(storedCurrentZone?.ownerTeamId).toBeNull();
    expect(storedTargetZone?.ownerTeamId).toBe(TEAM_ONE_ID);
  });

  it('commits expired-claim cleanup and returns claim expired', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'complete-expired-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    await seedClaimedChallenge({ expiresAt: new Date(Date.now() - 60_000) });
    app = await createTestApp({ db: testDatabase.db });

    const response = await completeRequest({
      sessionToken: 'complete-expired-session',
      actionId: 'complete-expired',
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers[STATE_VERSION_HEADER.toLowerCase()]).toBe('1');
    expect(response.json()).toEqual({
      error: {
        code: 'CLAIM_EXPIRED',
        message: 'Claim has expired.',
      },
    });

    const [storedChallenge] = await testDatabase.db.select().from(challenges).where(eq(challenges.id, CHALLENGE_ID));
    expect(storedChallenge?.status).toBe('available');
    expect(storedChallenge?.currentClaimId).toBeNull();
    expect(storedChallenge?.expiresAt).toBeNull();

    const [storedClaim] = await testDatabase.db.select().from(challengeClaims).where(eq(challengeClaims.id, CLAIM_ID));
    expect(storedClaim?.status).toBe('expired');
    expect(storedClaim?.releasedAt).toBeInstanceOf(Date);
    expect(storedClaim?.completedAt).toBeNull();

    const storedEvents = await testDatabase.db
      .select({ eventType: gameEvents.eventType, stateVersion: gameEvents.stateVersion })
      .from(gameEvents)
      .where(eq(gameEvents.gameId, GAME_ID))
      .orderBy(asc(gameEvents.createdAt));

    expect(storedEvents).toHaveLength(2);
    expect(storedEvents.map((event) => event.stateVersion)).toEqual([1, 1]);
    expect(storedEvents.map((event) => event.eventType).sort()).toEqual([
      eventTypes.objectiveStateChanged,
      eventTypes.challengeReleased,
    ].sort());
  });

  it('rejects completion attempts from another team', async () => {
    await seedGame();
    await seedTeam();
    await seedTeam({ id: TEAM_TWO_ID, name: 'Other Team', color: '#2563eb', joinCode: 'TEAM9999' });
    await seedPlayer({ sessionToken: 'complete-owner-session' });
    await seedPlayer({
      id: PLAYER_TWO_ID,
      teamId: TEAM_TWO_ID,
      sessionToken: 'complete-other-team-session',
      displayName: 'Player Two',
    });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id });
    await seedClaimedChallenge({ expiresAt: new Date(Date.now() + 5 * 60_000) });
    app = await createTestApp({ db: testDatabase.db });

    const response = await completeRequest({
      sessionToken: 'complete-other-team-session',
      actionId: 'complete-other-team',
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'CLAIM_NOT_YOURS',
        message: 'Claim belongs to another team.',
      },
    });
  });

  it('returns not found when no active claim exists for the challenge', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'complete-no-claim-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id, status: 'available', currentClaimId: null });
    app = await createTestApp({ db: testDatabase.db });

    const response = await completeRequest({
      sessionToken: 'complete-no-claim-session',
      actionId: 'complete-no-claim',
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'NO_ACTIVE_CLAIM',
        message: 'No active claim exists for this challenge.',
      },
    });
  });


  it('sends capture notifications to the capturing team and same-game rivals only', async () => {
    const notifications: TeamNotificationInput[] = [];
    await seedGame();
    await seedTeam();
    await seedTeam({ id: TEAM_TWO_ID, name: 'Other Team', color: '#2563eb', joinCode: 'TEAM9999' });
    await testDatabase.db.insert(games).values(createTestGame({ id: OUTSIDE_GAME_ID, name: 'Outside Game' }));
    await testDatabase.db.insert(teams).values(createTestTeam({
      id: OUTSIDE_GAME_TEAM_ID,
      gameId: OUTSIDE_GAME_ID,
      name: 'Outside Team',
      color: '#16a34a',
      joinCode: 'TEAM7777',
    }));
    await seedPlayer({ sessionToken: 'complete-notify-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id, scoring: { points: 5 } });
    await seedClaimedChallenge({ expiresAt: new Date(Date.now() + 5 * 60_000) });
    app = await createTestApp({
      db: testDatabase.db,
      notificationService: notificationRecorder(notifications),
    });

    const response = await completeRequest({
      sessionToken: 'complete-notify-session',
      actionId: 'complete-notify',
      payload: {},
    });

    expect(response.statusCode).toBe(200);

    await waitFor(async () => notifications.length === 2);

    expect(notifications).toEqual([
      {
        gameId: GAME_ID,
        teamId: TEAM_ONE_ID,
        title: 'Zone captured',
        body: 'Your team captured Downtown Zone.',
        priority: 'high',
        meta: {
          zoneId: zone.id,
          challengeId: CHALLENGE_ID,
          eventType: 'zone_captured',
        },
      },
      {
        gameId: GAME_ID,
        teamId: TEAM_TWO_ID,
        title: 'Rival zone captured',
        body: 'Another team captured Downtown Zone.',
        priority: 'medium',
        meta: {
          zoneId: zone.id,
          challengeId: CHALLENGE_ID,
          eventType: 'zone_captured',
        },
      },
    ]);
  });

  it('notifies teammates and rival teams when a Challenge Hunt challenge is completed', async () => {
    const notifications: TeamNotificationInput[] = [];
    await seedGame({ modeKey: 'point_challenge' });
    await seedTeam({ name: 'Gold Team' });
    await seedTeam({ id: TEAM_TWO_ID, name: 'Other Team', color: '#2563eb', joinCode: 'TEAM9999' });
    await seedPlayer({ sessionToken: 'hunt-notify-session', displayName: 'Sam' });
    await seedChallenge({ title: 'Bean selfie', zoneId: null, isDeckActive: true, config: { portable: true, location_mode: 'portable' }, scoring: { points: 20 } });
    app = await createTestApp({ db: testDatabase.db, notificationService: notificationRecorder(notifications) });

    const response = await completeRequest({ sessionToken: 'hunt-notify-session', actionId: 'hunt-notify', payload: { gps: validGpsPayload() } });

    expect(response.statusCode).toBe(200);
    await waitFor(async () => notifications.length === 2);
    const meta = { challengeId: CHALLENGE_ID, eventType: 'challenge_completed' };
    expect(notifications).toEqual([
      {
        gameId: GAME_ID,
        teamId: TEAM_ONE_ID,
        excludePlayerId: PLAYER_ONE_ID,
        title: 'Challenge completed',
        body: 'Sam completed "Bean selfie" (+20 pts).',
        priority: 'medium',
        meta,
      },
      {
        gameId: GAME_ID,
        teamId: TEAM_TWO_ID,
        title: 'Rival completed a challenge',
        body: 'Gold Team completed "Bean selfie". It\'s off the board.',
        priority: 'medium',
        meta,
      },
    ]);
  });

  it('only tells teammates about a judged Challenge Hunt submission', async () => {
    const notifications: TeamNotificationInput[] = [];
    await seedGame({ modeKey: 'point_challenge' });
    await seedTeam();
    await seedTeam({ id: TEAM_TWO_ID, name: 'Other Team', color: '#2563eb', joinCode: 'TEAM9999' });
    await seedPlayer({ sessionToken: 'hunt-judged-session', displayName: 'Sam' });
    await seedChallenge({ title: 'Best costume', zoneId: null, isDeckActive: true, config: { portable: true, location_mode: 'portable', judged: true, judging_type: 'pass_fail' }, scoring: { points: 5 } });
    app = await createTestApp({ db: testDatabase.db, notificationService: notificationRecorder(notifications) });

    const response = await completeRequest({ sessionToken: 'hunt-judged-session', actionId: 'hunt-judged', payload: { gps: validGpsPayload() } });

    expect(response.statusCode).toBe(200);
    await waitFor(async () => notifications.length === 1);
    expect(notifications).toEqual([
      {
        gameId: GAME_ID,
        teamId: TEAM_ONE_ID,
        excludePlayerId: PLAYER_ONE_ID,
        title: 'Submitted for judging',
        body: 'Sam submitted "Best costume" for judging.',
        priority: 'medium',
        meta: { challengeId: CHALLENGE_ID, eventType: 'challenge_completed' },
      },
    ]);
  });

  it('replays the same successful completion for the same idempotency key', async () => {
    await seedGame();
    await seedTeam();
    await seedPlayer({ sessionToken: 'complete-replay-session' });
    const zone = await seedZone();
    await seedChallenge({ zoneId: zone.id, scoring: { points: 7 } });
    await seedClaimedChallenge({ expiresAt: new Date(Date.now() + 5 * 60_000) });
    app = await createTestApp({ db: testDatabase.db });

    const payload = {
      submission: {
        code: 'done',
      },
    };

    const firstResponse = await completeRequest({
      sessionToken: 'complete-replay-session',
      actionId: 'complete-replay',
      payload,
    });
    const secondResponse = await completeRequest({
      sessionToken: 'complete-replay-session',
      actionId: 'complete-replay',
      payload,
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual(firstResponse.json());
    expect(secondResponse.headers[STATE_VERSION_HEADER.toLowerCase()]).toBe(
      firstResponse.headers[STATE_VERSION_HEADER.toLowerCase()],
    );

    const storedEvents = await testDatabase.db.select().from(gameEvents).where(eq(gameEvents.gameId, GAME_ID));
    const ledgerRows = await testDatabase.db.select().from(resourceLedger).where(eq(resourceLedger.gameId, GAME_ID));
    expect(storedEvents).toHaveLength(5);
    expect(ledgerRows).toHaveLength(1);
  });


  function validGpsPayload() {
    return {
      lat: 49.8951,
      lng: -97.1384,
      gpsErrorMeters: 8,
      speedMps: 0,
      headingDegrees: 90,
      capturedAt: new Date().toISOString(),
    };
  }

  async function completeRequest(input: {
    sessionToken: string;
    actionId: string;
    payload: Record<string, unknown>;
  }) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/challenges/${CHALLENGE_ID}/complete`,
      cookies: {
        [SESSION_COOKIE_NAME]: input.sessionToken,
      },
      headers: {
        'idempotency-key': input.actionId,
      },
      payload: input.payload,
    });
  }

  async function seedGame(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(games).values(createTestGame({ status: 'active', ...overrides }));
  }

  async function seedTeam(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(teams).values(createTestTeam(overrides));
  }

  async function seedPlayer(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(players).values(createTestPlayer({ id: PLAYER_ONE_ID, ...overrides }));
  }

  async function seedZone() {
    return createZone(testDatabase.db, {
      gameId: GAME_ID,
      name: 'Downtown Zone',
      geometry: ZONE_GEOMETRY,
      pointValue: 1,
    });
  }

  async function seedChallenge(overrides: Record<string, unknown> = {}) {
    await testDatabase.db.insert(challenges).values(createTestChallenge({
      id: CHALLENGE_ID,
      gameId: GAME_ID,
      ...overrides,
    }));
  }


  function notificationRecorder(collected: TeamNotificationInput[]): NotificationService {
    return {
      async sendTeamNotification(input) {
        collected.push(input);
      },
    };
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (await check()) {
        return;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }

    throw new Error('Timed out waiting for notification side effects.');
  }

  async function seedClaimedChallenge(overrides: { expiresAt: Date }) {
    await testDatabase.db.insert(challengeClaims).values({
      id: CLAIM_ID,
      challengeId: CHALLENGE_ID,
      gameId: GAME_ID,
      teamId: TEAM_ONE_ID,
      playerId: PLAYER_ONE_ID,
      status: 'active',
      expiresAt: overrides.expiresAt,
      locationAtClaim: sql`ST_SetSRID(ST_MakePoint(${-97.1384}, ${49.8951}), 4326)`,
    });

    await testDatabase.db
      .update(challenges)
      .set({
        status: 'claimed',
        currentClaimId: CLAIM_ID,
        expiresAt: overrides.expiresAt,
      })
      .where(eq(challenges.id, CHALLENGE_ID));
  }
});
