import 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GpsPayload } from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import type { players } from '../db/schema.js';
import type { ModeRegistry } from '../modes/index.js';
import type { OsmImportService } from '../services/osm-import-service.js';
import type { NotificationService } from '../services/notification-service.js';
import type { Broadcaster } from '../socket/broadcaster.js';
import type { RealtimeServer } from '../socket/broadcaster.js';

export type AuthenticatedPlayer = typeof players.$inferSelect;

declare module 'fastify' {
  interface FastifyInstance {
    db: DatabaseClient;
    modeRegistry: ModeRegistry;
    osmImportService: OsmImportService;
    notificationService: NotificationService;
    io: RealtimeServer;
    broadcaster: Broadcaster;
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireTeam(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    isAdminRequest(request: FastifyRequest): boolean;
    requireIdempotency(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    validateGps(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }

  interface FastifyRequest {
    player: AuthenticatedPlayer | null;
    gpsPayload: GpsPayload | null;
    idempotency: {
      actionId: string;
      actionType: string;
      scopeKey: string;
      requestHash: string;
      playerId: string | null;
    } | null;
  }
}
