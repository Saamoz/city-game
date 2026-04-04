import cookie from '@fastify/cookie';
import { parse, serialize } from 'cookie';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE_NAME, errorCodes } from '@city-game/shared';
import { env } from '../db/env.js';
import { players } from '../db/schema.js';
import type { DatabaseClient } from '../db/connection.js';
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

export function getSessionTokenFromCookieHeader(cookieHeader?: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  return parse(cookieHeader)[SESSION_COOKIE_NAME] ?? null;
}

export async function getPlayerBySessionToken(db: DatabaseClient, sessionToken: string) {
  const [player] = await db.select().from(players).where(eq(players.sessionToken, sessionToken)).limit(1);

  if (!player) {
    throw new AppError(errorCodes.unauthorized);
  }

  return player;
}

export function getSessionCookieOptions(options: SessionCookieOptions = {}) {
  return {
    path: '/',
    httpOnly: true,
    secure: options.secure ?? env.nodeEnv === 'production',
    sameSite: 'strict' as const,
  };
}

export function getSerializedSessionCookie(
  sessionToken: string,
  options: SessionCookieOptions = {},
): string {
  return serialize(SESSION_COOKIE_NAME, sessionToken, getSessionCookieOptions(options));
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

    request.player = await getPlayerBySessionToken(app.db, sessionToken);
  });

  app.decorate('requireTeam', async (request, reply) => {
    await app.authenticate(request, reply);

    if (!request.player?.teamId) {
      throw new AppError(errorCodes.notOnTeam);
    }
  });

  app.decorate('isAdminRequest', (request) => {
    const expectedToken = options.adminToken ?? env.adminToken;
    const providedToken = extractBearerToken(request.headers.authorization);
    return Boolean(expectedToken && providedToken && providedToken === expectedToken);
  });

  // Local V1 admin surfaces are intentionally unauthenticated.
  // Routes still detect explicit bearer tokens so mixed player/admin flows keep working.
  app.decorate('requireAdmin', async () => {});
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
