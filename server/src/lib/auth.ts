import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME, errorCodes } from '@city-game/shared';
import { env } from '../db/env.js';
import { players } from '../db/schema.js';
import { AppError } from './errors.js';
import { randomUUID } from 'node:crypto';

export interface AuthOptions {
  adminToken?: string;
}

export interface SessionCookieOptions {
  secure?: boolean;
}

export function generateSessionToken(): string {
  return randomUUID();
}

export function getSessionCookieOptions(options: SessionCookieOptions = {}) {
  return {
    path: '/',
    httpOnly: true,
    secure: options.secure ?? env.nodeEnv === 'production',
    sameSite: 'strict' as const,
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  sessionToken: string,
  options: SessionCookieOptions = {},
): void {
  reply.setCookie(SESSION_COOKIE_NAME, sessionToken, getSessionCookieOptions(options));
}

export function registerAuth(app: FastifyInstance, options: AuthOptions = {}): void {
  app.register(cookie);

  app.decorateRequest('player', null);

  app.decorate('authenticate', async (request) => {
    if (request.player) {
      return;
    }

    const sessionToken = request.cookies[SESSION_COOKIE_NAME];

    if (!sessionToken) {
      throw new AppError(errorCodes.unauthorized);
    }

    const [player] = await app.db
      .select()
      .from(players)
      .where(eq(players.sessionToken, sessionToken))
      .limit(1);

    if (!player) {
      throw new AppError(errorCodes.unauthorized);
    }

    request.player = player;
  });

  app.decorate('requireTeam', async (request, reply) => {
    await app.authenticate(request, reply);

    if (!request.player?.teamId) {
      throw new AppError(errorCodes.notOnTeam);
    }
  });

  app.decorate('requireAdmin', async (request) => {
    const bearerToken = extractBearerToken(request.headers.authorization);

    if (!bearerToken || bearerToken !== (options.adminToken ?? env.adminToken)) {
      throw new AppError(errorCodes.adminRequired);
    }
  });
}

function extractBearerToken(headerValue?: string) {
  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  return token;
}
