import {
  API_PREFIX,
  IDEMPOTENCY_KEY_HEADER,
  type Challenge,
  type ChallengeClaim,
  type ErrorResponse,
  type Game,
  type GameStateSnapshot,
  type GpsPayload,
  type JsonValue,
  type Player,
  type ResourceAwardMap,
  type Team,
  type Zone,
} from '@city-game/shared';

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string | null;
  readonly details: unknown;

  constructor(message: string, options: { statusCode: number; code?: string | null; details?: unknown }) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = options.statusCode;
    this.code = options.code ?? null;
    this.details = options.details;
  }
}

interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotent?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

interface GameResponse {
  game: Game;
}

interface PlayerResponse {
  player: Player;
}

interface JoinTeamResponse {
  player: Player;
  team: Team;
}

interface MapStateResponse {
  snapshot: GameStateSnapshot;
}

export interface ChallengeActionResponse {
  challenge: Challenge;
  claim: ChallengeClaim;
  stateVersion: number;
}

export interface CompleteChallengeResponse extends ChallengeActionResponse {
  zone: Zone | null;
  resourcesAwarded: ResourceAwardMap;
}

interface PlayerLocationResponse {
  player: Player;
  gps: GpsPayload;
  tracking: {
    enabled: boolean;
    sampleStored: boolean;
    retentionHours: number;
  };
}

const mutatingMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export async function getActiveGame(signal?: AbortSignal): Promise<Game> {
  const response = await apiRequest<GameResponse>('/game/active', { signal });
  return response.game;
}

export async function getGame(gameId: string, signal?: AbortSignal): Promise<Game> {
  const response = await apiRequest<GameResponse>(`/game/${gameId}`, { signal });
  return response.game;
}

export async function getCurrentPlayer(signal?: AbortSignal): Promise<Player> {
  const response = await apiRequest<PlayerResponse>('/players/me', { signal });
  return response.player;
}

export async function registerPlayer(gameId: string, displayName: string): Promise<Player> {
  const response = await apiRequest<PlayerResponse>(`/game/${gameId}/players`, {
    method: 'POST',
    body: {
      display_name: displayName,
    },
  });

  return response.player;
}

export async function joinTeam(gameId: string, joinCode: string): Promise<JoinTeamResponse> {
  return apiRequest<JoinTeamResponse>(`/game/${gameId}/teams/join`, {
    method: 'POST',
    body: {
      join_code: joinCode,
    },
  });
}

export async function getMapState(gameId: string, signal?: AbortSignal): Promise<GameStateSnapshot> {
  const response = await apiRequest<MapStateResponse>(`/game/${gameId}/map-state`, { signal });
  return response.snapshot;
}

export async function claimChallenge(challengeId: string, gps: GpsPayload, idempotencyKey?: string): Promise<ChallengeActionResponse> {
  return apiRequest<ChallengeActionResponse>(`/challenges/${challengeId}/claim`, {
    method: 'POST',
    body: gps,
    idempotencyKey,
  });
}

export async function completeChallenge(
  challengeId: string,
  input?: {
    submission?: JsonValue | null;
    gps?: GpsPayload | null;
  },
  idempotencyKey?: string,
): Promise<CompleteChallengeResponse> {
  return apiRequest<CompleteChallengeResponse>(`/challenges/${challengeId}/complete`, {
    method: 'POST',
    body: {
      submission: input?.submission ?? null,
      gps: input?.gps ?? null,
    },
    idempotencyKey,
  });
}

export async function releaseChallenge(challengeId: string, idempotencyKey?: string): Promise<ChallengeActionResponse> {
  return apiRequest<ChallengeActionResponse>(`/challenges/${challengeId}/release`, {
    method: 'POST',
    idempotencyKey,
  });
}

export async function updatePlayerLocation(gps: GpsPayload, idempotencyKey?: string): Promise<PlayerLocationResponse> {
  return apiRequest<PlayerLocationResponse>('/players/me/location', {
    method: 'POST',
    body: gps,
    idempotencyKey,
  });
}

async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers = new Headers();

  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  if (options.idempotent !== false && mutatingMethods.has(method)) {
    headers.set(IDEMPOTENCY_KEY_HEADER, options.idempotencyKey ?? crypto.randomUUID());
  }

  const response = await fetch(`${API_PREFIX}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  const payload = await readJson(response);

  if (!response.ok) {
    const error = (payload ?? null) as ErrorResponse | null;
    throw new ApiError(
      error?.error.message ?? `Request failed with status ${response.status}.`,
      {
        statusCode: response.status,
        code: error?.error.code ?? null,
        details: error?.error.details,
      },
    );
  }

  return payload as T;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
