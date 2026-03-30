import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { errorCodes } from '@city-game/shared';
import { AppError } from './errors.js';
import { createTestApp } from '../test/create-test-app.js';

describe('app error handler', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('serializes AppError responses using the shared contract', async () => {
    app = await createTestApp({
      register(instance) {
        instance.get('/test/app-error', async () => {
          throw new AppError(errorCodes.notOnTeam, {
            details: {
              requiresTeam: true,
            },
          });
        });
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/test/app-error',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_ON_TEAM',
        message: 'Player must join a team first.',
        details: {
          requiresTeam: true,
        },
      },
    });
  });

  it('normalizes Fastify validation errors into VALIDATION_ERROR', async () => {
    app = await createTestApp({
      register(instance) {
        instance.post(
          '/test/validation',
          {
            schema: {
              body: {
                type: 'object',
                additionalProperties: false,
                required: ['displayName'],
                properties: {
                  displayName: {
                    type: 'string',
                    minLength: 1,
                  },
                },
              },
            },
          },
          async () => ({ ok: true }),
        );
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test/validation',
      payload: {},
    });

    const body = response.json();

    expect(response.statusCode).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        details: {
          context: 'body',
        },
      },
    });
    expect(body.error.message).toContain('displayName');
    expect(body.error.details.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: 'required',
        }),
      ]),
    );
  });
});
