import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  IDEMPOTENCY_KEY_HEADER,
  errorCodes,
  type ActionReceipt,
  type JsonObject,
  type JsonValue,
} from '@city-game/shared';
import type { DatabaseClient } from '../db/connection.js';
import { actionReceipts } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

interface ActionReceiptRow {
  id: string;
  gameId: string;
  playerId: string | null;
  scopeKey: string;
  actionType: string;
  actionId: string;
  requestHash: string;
  response: unknown;
  responseHeaders: JsonObject;
  statusCode: number;
  createdAt: Date;
}

export interface IdempotencyContext {
  actionId: string;
  actionType: string;
  scopeKey: string;
  requestHash: string;
  playerId: string | null;
}

export interface StoreActionReceiptInput extends IdempotencyContext {
  gameId: string;
  response: unknown;
  responseHeaders: JsonObject;
  statusCode: number;
}

export interface IdempotentMutationResult {
  gameId: string;
  playerId?: string | null;
  statusCode: number;
  body?: unknown;
  responseHeaders?: JsonObject;
}

export interface ExecutedMutationResult {
  statusCode: number;
  body: unknown;
  responseHeaders: JsonObject;
}

export async function findStoredReceipt(
  db: DatabaseClient,
  context: IdempotencyContext,
): Promise<ActionReceipt | null> {
  const [receipt] = await db
    .select()
    .from(actionReceipts)
    .where(
      and(
        eq(actionReceipts.scopeKey, context.scopeKey),
        eq(actionReceipts.actionType, context.actionType),
        eq(actionReceipts.actionId, context.actionId),
      ),
    )
    .limit(1);

  if (!receipt) {
    return null;
  }

  if (receipt.requestHash !== context.requestHash) {
    throw new AppError(errorCodes.idempotencyConflict);
  }

  return serializeActionReceipt(receipt as ActionReceiptRow);
}

export async function storeActionReceipt(
  db: DatabaseClient,
  input: StoreActionReceiptInput,
): Promise<ActionReceipt> {
  const [receipt] = await db
    .insert(actionReceipts)
    .values({
      gameId: input.gameId,
      playerId: input.playerId,
      scopeKey: input.scopeKey,
      actionType: input.actionType,
      actionId: input.actionId,
      requestHash: input.requestHash,
      response: input.response,
      responseHeaders: input.responseHeaders,
      statusCode: input.statusCode,
    })
    .returning();

  return serializeActionReceipt(receipt as ActionReceiptRow);
}

export async function executeIdempotentMutation(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  run: (db: DatabaseClient) => Promise<IdempotentMutationResult>,
  onCommitted?: (result: ExecutedMutationResult) => Promise<void> | void,
): Promise<void> {
  const context = request.idempotency;

  if (!context) {
    throw new Error('Idempotency context missing.');
  }

  const result = await app.db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as DatabaseClient;
    const mutation = await run(transactionalDb);
    const responseBody = mutation.statusCode === 204 ? {} : mutation.body ?? null;
    const responseHeaders = {
      ...normalizeResponseHeaders(reply),
      ...(mutation.responseHeaders ?? {}),
    } satisfies JsonObject;

    await storeActionReceipt(transactionalDb, {
      gameId: mutation.gameId,
      playerId: mutation.playerId ?? context.playerId,
      scopeKey: context.scopeKey,
      actionType: context.actionType,
      actionId: context.actionId,
      requestHash: context.requestHash,
      response: responseBody,
      responseHeaders,
      statusCode: mutation.statusCode,
    });

    return {
      statusCode: mutation.statusCode,
      body: responseBody,
      responseHeaders,
    };
  });

  applyStoredHeaders(reply, result.responseHeaders);
  sendStoredResponse(reply, result.statusCode, result.body);

  if (onCommitted) {
    try {
      await onCommitted(result);
    } catch (error) {
      app.log.error({ err: error }, 'post-commit hook failed');
    }
  }
}

export function buildIdempotencyContext(app: FastifyInstance, request: FastifyRequest): IdempotencyContext {
  const actionId = getRequiredActionId(request);
  const actionType = request.method.toUpperCase() + ' ' + request.routeOptions.url;
  const playerId = request.player?.id ?? null;
  const scopeKey = playerId ? 'player:' + playerId : app.isAdminRequest(request) ? 'admin' : 'public';

  return {
    actionId,
    actionType,
    scopeKey,
    requestHash: hashRequestPayload({
      params: request.params ?? null,
      query: request.query ?? null,
      body: request.body ?? null,
    }),
    playerId,
  };
}

export function replayStoredReceipt(reply: FastifyReply, receipt: ActionReceipt): void {
  applyStoredHeaders(reply, receipt.responseHeaders);
  sendStoredResponse(reply, receipt.statusCode, receipt.response);
}

export function hashRequestPayload(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function getRequiredActionId(request: FastifyRequest): string {
  const headerValue = request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
  const actionId = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (!actionId) {
    throw new AppError(errorCodes.validationError, {
      message: 'Idempotency-Key header required.',
    });
  }

  return actionId;
}

function normalizeResponseHeaders(reply: FastifyReply): JsonObject {
  const headers = reply.getHeaders();
  const normalizedEntries = Object.entries(headers)
    .map(([key, value]) => [key, normalizeHeaderValue(value)] as const)
    .filter((entry) => entry[1] !== undefined);

  const setCookieHeader = normalizeHeaderValue(reply.getHeader('set-cookie'));

  if (setCookieHeader !== undefined && !normalizedEntries.some(([key]) => key === 'set-cookie')) {
    normalizedEntries.push(['set-cookie', setCookieHeader]);
  }

  return Object.fromEntries(normalizedEntries) as JsonObject;
}

function normalizeHeaderValue(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return undefined;
}

function applyStoredHeaders(reply: FastifyReply, headers: JsonObject): void {
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      reply.header(key, value);
      continue;
    }

    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      reply.header(key, value);
    }
  }
}

function sendStoredResponse(reply: FastifyReply, statusCode: number, body: unknown): void {
  reply.status(statusCode);

  if (statusCode === 204) {
    reply.send();
    return;
  }

  reply.send(body);
}

function serializeActionReceipt(row: ActionReceiptRow): ActionReceipt {
  return {
    id: row.id,
    gameId: row.gameId,
    playerId: row.playerId,
    scopeKey: row.scopeKey,
    actionType: row.actionType,
    actionId: row.actionId,
    requestHash: row.requestHash,
    response: row.response as JsonValue,
    responseHeaders: row.responseHeaders,
    statusCode: row.statusCode,
    createdAt: row.createdAt.toISOString(),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nestedValue]) => nestedValue !== undefined)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, nestedValue]) => [key, sortValue(nestedValue)]),
    );
  }

  return value ?? null;
}