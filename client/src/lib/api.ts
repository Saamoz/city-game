import {
  API_PREFIX,
  IDEMPOTENCY_KEY_HEADER,
  type Challenge,
  type ChallengeClaim,
  type ChallengeSet,
  type ChallengeSetItem,
  type ErrorResponse,
  type Game,
  type GameEventRecord,
  type GameEventType,
  type GameStateSnapshot,
  type GeoJsonFeatureCollection,
  type GeoJsonGeometry,
  type GeoJsonPoint,
  type GpsPayload,
  type JsonObject,
  type JsonValue,
  type MapDefinition,
  type MapZone,
  type Player,
  type ResourceAwardMap,
  type ScoreboardEntry,
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
  headers?: HeadersInit;
  idempotent?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

interface GameResponse { game: Game }
interface ChallengeSetsResponse { challengeSets: ChallengeSet[] }
interface ChallengeSetResponse { challengeSet: ChallengeSet }
interface ChallengeSetItemsResponse { items: ChallengeSetItem[] }
interface ChallengeSetItemResponse { item: ChallengeSetItem }
interface MapsResponse { maps: MapDefinition[] }
interface MapResponse { map: MapDefinition }
interface PlayerResponse { player: Player }
interface JoinTeamResponse { player: Player; team: Team }
interface TeamsResponse { teams: Team[] }
interface MapStateResponse { snapshot: GameStateSnapshot }
interface ScoreboardResponse { scoreboard: ScoreboardEntry[] }
interface RecentEventsResponse { events: GameEventRecord[] }
interface ZonesResponse { zones: Zone[] }
interface ZoneResponse { zone: Zone }
interface MapZonesResponse { zones: MapZone[] }
interface MapZoneResponse { zone: MapZone }
interface ZoneImportResponse { zones: Zone[] }
interface MapZoneImportResponse { zones: MapZone[] }

interface PlayerLocationResponse {
  player: Player;
  gps: GpsPayload;
  tracking: {
    enabled: boolean;
    sampleStored: boolean;
    retentionHours: number;
  };
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

export interface ZoneUpsertInput {
  name: string;
  geometry: GeoJsonGeometry;
  ownerTeamId?: string | null;
  pointValue?: number;
  claimRadiusMeters?: number | null;
  maxGpsErrorMeters?: number | null;
  isDisabled?: boolean;
  metadata?: JsonObject;
}

export interface MapUpsertInput {
  name: string;
  city?: string | null;
  centerLat: number;
  centerLng: number;
  defaultZoom: number;
  boundary?: GeoJsonGeometry | null;
  metadata?: JsonObject;
}

export interface MapZoneUpsertInput {
  name: string;
  geometry: GeoJsonGeometry;
  pointValue?: number;
  claimRadiusMeters?: number | null;
  maxGpsErrorMeters?: number | null;
  isDisabled?: boolean;
  metadata?: JsonObject;
}

const mutatingMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export async function getActiveGame(signal?: AbortSignal): Promise<Game> {
  const response = await apiRequest<GameResponse>('/game/active', { signal });
  return response.game;
}

export async function getGame(gameId: string, signal?: AbortSignal): Promise<Game> {
  const response = await apiRequest<GameResponse>('/game/' + gameId, { signal });
  return response.game;
}

export async function listMaps(signal?: AbortSignal): Promise<MapDefinition[]> {
  const response = await apiRequest<MapsResponse>('/maps', { signal });
  return response.maps;
}

export async function getMap(mapId: string, signal?: AbortSignal): Promise<MapDefinition> {
  const response = await apiRequest<MapResponse>('/maps/' + mapId, { signal });
  return response.map;
}

export async function listChallengeSets(signal?: AbortSignal): Promise<ChallengeSet[]> {
  const response = await apiRequest<ChallengeSetsResponse>('/challenge-sets', { signal });
  return response.challengeSets;
}

export async function getChallengeSet(challengeSetId: string, signal?: AbortSignal): Promise<ChallengeSet> {
  const response = await apiRequest<ChallengeSetResponse>('/challenge-sets/' + challengeSetId, { signal });
  return response.challengeSet;
}

export async function createChallengeSetDefinition(input: { name: string; description?: string | null; metadata?: JsonObject }): Promise<ChallengeSet> {
  const response = await apiRequest<ChallengeSetResponse>('/challenge-sets', {
    method: 'POST',
    body: input,
  });
  return response.challengeSet;
}

export async function updateChallengeSetDefinition(
  challengeSetId: string,
  input: { name?: string; description?: string | null; metadata?: JsonObject },
): Promise<ChallengeSet> {
  const response = await apiRequest<ChallengeSetResponse>('/challenge-sets/' + challengeSetId, {
    method: 'PATCH',
    body: input,
  });
  return response.challengeSet;
}

export async function deleteChallengeSetDefinition(challengeSetId: string): Promise<void> {
  await apiRequest<null>('/challenge-sets/' + challengeSetId, {
    method: 'DELETE',
  });
}

export async function listChallengeSetItems(challengeSetId: string, signal?: AbortSignal): Promise<ChallengeSetItem[]> {
  const response = await apiRequest<ChallengeSetItemsResponse>('/challenge-sets/' + challengeSetId + '/items', { signal });
  return response.items;
}

export async function createChallengeSetItemDefinition(
  challengeSetId: string,
  input: {
    mapZoneId?: string | null;
    mapPoint?: GeoJsonPoint | null;
    title: string;
    description: string;
    config?: JsonObject;
    scoring?: Record<string, number>;
    difficulty?: Challenge['difficulty'] | null;
    sortOrder?: number;
    metadata?: JsonObject;
  },
): Promise<ChallengeSetItem> {
  const response = await apiRequest<ChallengeSetItemResponse>('/challenge-sets/' + challengeSetId + '/items', {
    method: 'POST',
    body: input,
  });
  return response.item;
}

export async function updateChallengeSetItemDefinition(
  challengeSetItemId: string,
  input: {
    mapZoneId?: string | null;
    mapPoint?: GeoJsonPoint | null;
    title?: string;
    description?: string;
    config?: JsonObject;
    scoring?: Record<string, number>;
    difficulty?: Challenge['difficulty'] | null;
    sortOrder?: number;
    metadata?: JsonObject;
  },
): Promise<ChallengeSetItem> {
  const response = await apiRequest<ChallengeSetItemResponse>('/challenge-set-items/' + challengeSetItemId, {
    method: 'PATCH',
    body: input,
  });
  return response.item;
}

export async function deleteChallengeSetItemDefinition(challengeSetItemId: string): Promise<void> {
  await apiRequest<null>('/challenge-set-items/' + challengeSetItemId, {
    method: 'DELETE',
  });
}

export async function createMapDefinition(input: MapUpsertInput): Promise<MapDefinition> {
  const response = await apiRequest<MapResponse>('/maps', {
    method: 'POST',
    body: input,
  });
  return response.map;
}

export async function updateMapDefinition(mapId: string, input: Partial<MapUpsertInput>): Promise<MapDefinition> {
  const response = await apiRequest<MapResponse>('/maps/' + mapId, {
    method: 'PATCH',
    body: input,
  });
  return response.map;
}

export async function listMapZones(mapId: string, signal?: AbortSignal): Promise<MapZone[]> {
  const response = await apiRequest<MapZonesResponse>('/maps/' + mapId + '/zones', { signal });
  return response.zones;
}

export async function createMapZoneDefinition(mapId: string, input: MapZoneUpsertInput): Promise<MapZone> {
  const response = await apiRequest<MapZoneResponse>('/maps/' + mapId + '/zones', {
    method: 'POST',
    body: input,
  });
  return response.zone;
}

export async function updateMapZoneDefinition(mapZoneId: string, input: Partial<MapZoneUpsertInput>): Promise<MapZone> {
  const response = await apiRequest<MapZoneResponse>('/map-zones/' + mapZoneId, {
    method: 'PATCH',
    body: input,
  });
  return response.zone;
}

export async function deleteMapZoneDefinition(mapZoneId: string): Promise<void> {
  await apiRequest<null>('/map-zones/' + mapZoneId, {
    method: 'DELETE',
  });
}

export async function importMapZoneDefinitions(
  mapId: string,
  featureCollection: GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject>,
): Promise<MapZone[]> {
  const response = await apiRequest<MapZoneImportResponse>('/maps/' + mapId + '/zones/import', {
    method: 'POST',
    body: featureCollection,
  });
  return response.zones;
}

export async function previewOsmMapZones(
  mapId: string,
  city: string | null,
  signal?: AbortSignal,
): Promise<GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject>> {
  return apiRequest<GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject>>('/maps/' + mapId + '/zones/import-osm', {
    method: 'POST',
    body: city ? { city } : {},
    signal,
    idempotent: false,
  });
}

export async function splitMapZone(mapZoneId: string, splitLine?: GeoJsonGeometry): Promise<MapZone[]> {
  const response = await apiRequest<MapZoneImportResponse>('/map-zones/' + mapZoneId + '/split', {
    method: 'POST',
    body: splitLine ? { splitLine } : {},
  });
  return response.zones;
}

export async function mergeMapZones(zoneIds: [string, string], name?: string): Promise<MapZone> {
  const response = await apiRequest<MapZoneResponse>('/map-zones/merge', {
    method: 'POST',
    body: { zoneIds, name: name?.trim() || undefined },
  });
  return response.zone;
}

export async function getCurrentPlayer(signal?: AbortSignal): Promise<Player> {
  const response = await apiRequest<PlayerResponse>('/players/me', { signal });
  return response.player;
}

export async function registerPlayer(gameId: string, displayName: string): Promise<Player> {
  const response = await apiRequest<PlayerResponse>('/game/' + gameId + '/players', {
    method: 'POST',
    body: { display_name: displayName },
  });
  return response.player;
}

export async function joinTeam(gameId: string, joinCode: string): Promise<JoinTeamResponse> {
  return apiRequest<JoinTeamResponse>('/game/' + gameId + '/teams/join', {
    method: 'POST',
    body: { join_code: joinCode },
  });
}

export async function getMapState(gameId: string, signal?: AbortSignal): Promise<GameStateSnapshot> {
  const response = await apiRequest<MapStateResponse>('/game/' + gameId + '/map-state', { signal });
  return response.snapshot;
}

export async function getTeams(gameId: string, signal?: AbortSignal): Promise<Team[]> {
  const response = await apiRequest<TeamsResponse>('/game/' + gameId + '/teams', { signal });
  return response.teams;
}

export async function getScoreboard(gameId: string, signal?: AbortSignal): Promise<ScoreboardEntry[]> {
  const response = await apiRequest<ScoreboardResponse>('/game/' + gameId + '/scoreboard', { signal });
  return response.scoreboard;
}

export async function getRecentEvents(
  gameId: string,
  options: { limit?: number; eventType?: GameEventType; signal?: AbortSignal } = {},
): Promise<GameEventRecord[]> {
  const searchParams = new URLSearchParams();
  if (typeof options.limit === 'number') {
    searchParams.set('limit', String(options.limit));
  }
  if (options.eventType) {
    searchParams.set('eventType', options.eventType);
  }
  const query = searchParams.size ? '?' + searchParams.toString() : '';
  const response = await apiRequest<RecentEventsResponse>('/game/' + gameId + '/events' + query, { signal: options.signal });
  return response.events;
}

export async function claimChallenge(challengeId: string, gps: GpsPayload, idempotencyKey?: string): Promise<ChallengeActionResponse> {
  return apiRequest<ChallengeActionResponse>('/challenges/' + challengeId + '/claim', {
    method: 'POST',
    body: gps,
    idempotencyKey,
  });
}

export async function completeChallenge(
  challengeId: string,
  input?: { submission?: JsonValue | null; gps?: GpsPayload | null },
  idempotencyKey?: string,
): Promise<CompleteChallengeResponse> {
  return apiRequest<CompleteChallengeResponse>('/challenges/' + challengeId + '/complete', {
    method: 'POST',
    body: {
      submission: input?.submission ?? null,
      gps: input?.gps ?? null,
    },
    idempotencyKey,
  });
}

export async function releaseChallenge(challengeId: string, idempotencyKey?: string): Promise<ChallengeActionResponse> {
  return apiRequest<ChallengeActionResponse>('/challenges/' + challengeId + '/release', {
    method: 'POST',
    idempotencyKey,
  });
}

export async function listZones(gameId: string, signal?: AbortSignal): Promise<Zone[]> {
  const response = await apiRequest<ZonesResponse>('/game/' + gameId + '/zones', { signal });
  return response.zones;
}

export async function createAdminZone(gameId: string, input: ZoneUpsertInput, adminToken: string): Promise<Zone> {
  const response = await apiRequest<ZoneResponse>('/game/' + gameId + '/zones', {
    method: 'POST',
    body: input,
    headers: adminHeaders(adminToken),
  });
  return response.zone;
}

export async function updateAdminZone(zoneId: string, input: Partial<ZoneUpsertInput>, adminToken: string): Promise<Zone> {
  const response = await apiRequest<ZoneResponse>('/zones/' + zoneId, {
    method: 'PATCH',
    body: input,
    headers: adminHeaders(adminToken),
  });
  return response.zone;
}

export async function deleteAdminZone(zoneId: string, adminToken: string): Promise<void> {
  await apiRequest<null>('/zones/' + zoneId, {
    method: 'DELETE',
    headers: adminHeaders(adminToken),
  });
}

export async function importAdminZones(
  gameId: string,
  featureCollection: GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject>,
  adminToken: string,
): Promise<Zone[]> {
  const response = await apiRequest<ZoneImportResponse>('/game/' + gameId + '/zones/import', {
    method: 'POST',
    body: featureCollection,
    headers: adminHeaders(adminToken),
  });
  return response.zones;
}

export async function previewOsmZones(
  gameId: string,
  city: string,
  adminToken: string,
  signal?: AbortSignal,
): Promise<GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject>> {
  return apiRequest<GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject>>('/game/' + gameId + '/zones/import-osm', {
    method: 'POST',
    body: { city },
    headers: adminHeaders(adminToken),
    signal,
    idempotent: false,
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
  const headers = new Headers(options.headers);

  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  if (options.idempotent !== false && mutatingMethods.has(method)) {
    headers.set(IDEMPOTENCY_KEY_HEADER, options.idempotencyKey ?? crypto.randomUUID());
  }

  const response = await fetch(API_PREFIX + path, {
    method,
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  const payload = await readJson(response);

  if (!response.ok) {
    const error = (payload ?? null) as ErrorResponse | null;
    throw new ApiError(error?.error.message ?? ('Request failed with status ' + response.status + '.'), {
      statusCode: response.status,
      code: error?.error.code ?? null,
      details: error?.error.details,
    });
  }

  return payload as T;
}

function adminHeaders(adminToken: string): HeadersInit {
  return {
    Authorization: 'Bearer ' + adminToken,
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
