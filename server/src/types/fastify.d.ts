import 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseClient } from '../db/connection.js';
import type { players } from '../db/schema.js';

export type AuthenticatedPlayer = typeof players.$inferSelect;

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseClient;
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireTeam(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }

  interface FastifyRequest {
    player: AuthenticatedPlayer | null;
  }
}
