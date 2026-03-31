import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { actionReceipts, games, teams } from '../db/schema.js';
import { executeIdempotentMutation, hashRequestPayload } from '../services/idempotency-service.js';
import { createTestApp } from '../test/create-test-app.js';
import { createTestGame, createTestTeam } from '../test/factories.js';
import { closeTestDatabase, getTestDatabase, resetTestDatabase } from '../test/test-db.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const ACTION_ID = 'atomic-team-key';
const ACTION_TYPE = 'POST /api/v1/test/atomic-team';
const REQUEST_BODY = { name: 'Atomic Team' };

describe('idempotency middleware', () => {
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

  it('rolls back the mutation when receipt storage fails', async () => {
    await testDatabase.db.insert(games).values(createTestGame());
    await seedDuplicateReceipt();
    app = await createIdempotencyTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test/atomic-team',
      payload: REQUEST_BODY,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error.',
      },
    });

    const storedTeams = await testDatabase.db.select().from(teams).where(eq(teams.id, TEAM_ID));
    expect(storedTeams).toHaveLength(0);

    const storedReceipts = await testDatabase.db
      .select()
      .from(actionReceipts)
      .where(eq(actionReceipts.actionId, ACTION_ID));

    expect(storedReceipts).toHaveLength(1);
  });

  async function createIdempotencyTestApp() {
    return createTestApp({
      db: testDatabase.db,
      register: async (testApp) => {
        testApp.post(
          '/api/v1/test/atomic-team',
          {
            config: {
              skipIdempotency: true,
            },
          },
          async (request, reply) => {
            request.idempotency = {
              actionId: ACTION_ID,
              actionType: ACTION_TYPE,
              scopeKey: 'public',
              requestHash: hashRequestPayload({
                params: request.params ?? null,
                query: request.query ?? null,
                body: request.body ?? null,
              }),
              playerId: null,
            };

            await executeIdempotentMutation(testApp, request, reply, async (db) => {
              await db.insert(teams).values(
                createTestTeam({
                  id: TEAM_ID,
                  name: 'Atomic Team',
                  joinCode: 'ATOMIC01',
                }),
              );

              return {
                gameId: GAME_ID,
                statusCode: 201,
                body: { ok: true },
              };
            });
          },
        );
      },
    });
  }

  async function seedDuplicateReceipt() {
    await testDatabase.db.insert(actionReceipts).values({
      gameId: GAME_ID,
      playerId: null,
      scopeKey: 'public',
      actionType: ACTION_TYPE,
      actionId: ACTION_ID,
      requestHash: hashRequestPayload({
        params: {},
        query: {},
        body: REQUEST_BODY,
      }),
      response: { ok: true },
      responseHeaders: {},
      statusCode: 201,
    });
  }
});
