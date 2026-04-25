import {
  ANNOTATION_VISIBILITY_VALUES,
  CHALLENGE_KIND_VALUES,
  CHALLENGE_STATUS_VALUES,
  CLAIM_STATUS_VALUES,
  GAME_MODE_KEYS,
  GAME_STATUS_VALUES,
  PLAYER_LOCATION_SOURCE_VALUES,
} from './constants.js';
import type { GameEventType } from './events.js';
import type { ResourceType } from './resources.js';

export type Uuid = string;
export type IsoTimestamp = string;
export type HexColor = `#${string}`;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface JsonArray extends Array<JsonValue> {}

export type GeoJsonPosition = [number, number] | [number, number, number];

export interface GeoJsonPoint {
  type: 'Point';
  coordinates: GeoJsonPosition;
}

export interface GeoJsonLineString {
  type: 'LineString';
  coordinates: GeoJsonPosition[];
}

export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: GeoJsonPosition[][];
}

export interface GeoJsonMultiPolygon {
  type: 'MultiPolygon';
  coordinates: GeoJsonPosition[][][];
}

export type GeoJsonGeometry =
  | GeoJsonPoint
  | GeoJsonLineString
  | GeoJsonPolygon
  | GeoJsonMultiPolygon;

export interface GeoJsonFeature<TGeometry extends GeoJsonGeometry = GeoJsonGeometry, TProperties extends JsonObject = JsonObject> {
  type: 'Feature';
  geometry: TGeometry;
  properties: TProperties;
  id?: string | number;
}

export interface GeoJsonFeatureCollection<
  TGeometry extends GeoJsonGeometry = GeoJsonGeometry,
  TProperties extends JsonObject = JsonObject,
> {
  type: 'FeatureCollection';
  features: Array<GeoJsonFeature<TGeometry, TProperties>>;
}

export type GameModeKey = (typeof GAME_MODE_KEYS)[number];
export type GameStatus = (typeof GAME_STATUS_VALUES)[number];
export type ChallengeKind = (typeof CHALLENGE_KIND_VALUES)[number];
export type ChallengeStatus = (typeof CHALLENGE_STATUS_VALUES)[number];
export type ClaimStatus = (typeof CLAIM_STATUS_VALUES)[number];
export type AnnotationVisibility = (typeof ANNOTATION_VISIBILITY_VALUES)[number];
export type PlayerLocationSource =
  | (typeof PLAYER_LOCATION_SOURCE_VALUES)[number]
  | (string & {});

export type ChallengeCompletionMode = 'self_report' | (string & {});
export type ChallengeDifficulty = 'easy' | 'medium' | 'hard' | (string & {});
export type ChallengeSetItemLocationMode = 'portable' | 'zone' | 'point';
export type AnnotationType = 'marker' | 'line' | 'polygon' | 'circle' | 'note' | (string & {});
export type EventActorType = 'player' | 'team' | 'admin' | 'system';
export type EventEntityType =
  | 'game'
  | 'team'
  | 'player'
  | 'zone'
  | 'challenge'
  | 'challenge_claim'
  | 'resource_ledger'
  | 'annotation';

export interface PushSubscriptionData {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
    [key: string]: string;
  };
}

export type NotificationConfig = JsonObject & {
  enabled?: boolean;
  claimExpiryWarningMinutes?: number;
};

export type GameSettings = JsonObject & {
  location_tracking_enabled?: boolean;
  location_retention_hours?: number;
  notification_config?: NotificationConfig;
  max_concurrent_claims?: number;
  claim_timeout_minutes?: number;
  active_challenge_count?: number;
  challenge_total_count?: number;
  require_gps_accuracy?: boolean;  // default false. When true, enforces global and per-zone
                                   // GPS error radius checks on claim. Spatial containment
                                   // (ST_Covers) always applies regardless of this setting.
  broadcast_team_locations?: boolean;
  allow_midgame_join?: boolean;
};

export type WinCondition =
  | { type: 'all_zones' }
  | { type: 'zone_majority'; threshold: number }
  | { type: 'time_limit'; duration_minutes: number }
  | { type: 'score_threshold'; target: number };

export type WinConditions = WinCondition[];
export type ResourceAwardMap = Partial<Record<string, number>>;

export interface MapDefinition {
  id: Uuid;
  name: string;
  city: string | null;
  centerLat: number;
  centerLng: number;
  defaultZoom: number;
  boundary: GeoJsonPolygon | null;
  metadata: JsonObject;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface MapZone {
  id: Uuid;
  mapId: Uuid;
  name: string;
  geometry: GeoJsonGeometry;
  centroid: GeoJsonPoint | null;
  pointValue: number;
  claimRadiusMeters: number | null;
  maxGpsErrorMeters: number | null;
  isDisabled: boolean;
  metadata: JsonObject;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ChallengeSet {
  id: Uuid;
  name: string;
  description: string | null;
  metadata: JsonObject;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ChallengeSetItem {
  id: Uuid;
  setId: Uuid;
  mapZoneId: Uuid | null;
  mapPoint: GeoJsonPoint | null;
  title: string;
  description: string;
  kind: ChallengeKind;
  config: JsonObject;
  completionMode: ChallengeCompletionMode;
  scoring: ResourceAwardMap;
  difficulty: ChallengeDifficulty | null;
  sortOrder: number;
  metadata: JsonObject;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface Game {
  id: Uuid;
  mapId: Uuid | null;
  challengeSetId: Uuid | null;
  name: string;
  modeKey: GameModeKey;
  city: string | null;
  centerLat: number;
  centerLng: number;
  defaultZoom: number;
  boundary: GeoJsonPolygon | null;
  status: GameStatus;
  stateVersion: number;
  winCondition: WinConditions;
  settings: GameSettings;
  startedAt: IsoTimestamp | null;
  endedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface Team {
  id: Uuid;
  gameId: Uuid;
  name: string;
  color: HexColor;
  icon: string | null;
  joinCode: string;
  metadata: JsonObject;
  createdAt: IsoTimestamp;
}

export interface Player {
  id: Uuid;
  gameId: Uuid;
  teamId: Uuid | null;
  displayName: string;
  sessionToken: string;
  pushSubscription: PushSubscriptionData | null;
  lastLat: number | null;
  lastLng: number | null;
  lastGpsError: number | null;
  lastSeenAt: IsoTimestamp | null;
  metadata: JsonObject;
  createdAt: IsoTimestamp;
}

export interface TeamLocation {
  teamId: Uuid;
  lat: number;
  lng: number;
  gpsErrorMeters: number | null;
  updatedAt: IsoTimestamp;
}

export interface Zone {
  id: Uuid;
  gameId: Uuid;
  name: string;
  geometry: GeoJsonGeometry;
  centroid: GeoJsonPoint | null;
  ownerTeamId: Uuid | null;
  capturedAt: IsoTimestamp | null;
  pointValue: number;
  claimRadiusMeters: number | null;
  maxGpsErrorMeters: number | null;
  isDisabled: boolean;
  metadata: JsonObject;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface Challenge {
  id: Uuid;
  gameId: Uuid;
  zoneId: Uuid | null;
  title: string;
  description: string;
  kind: ChallengeKind;
  config: JsonObject;
  completionMode: ChallengeCompletionMode;
  scoring: ResourceAwardMap;
  difficulty: ChallengeDifficulty | null;
  sortOrder: number;
  isDeckActive: boolean;
  status: ChallengeStatus;
  currentClaimId: Uuid | null;
  expiresAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ChallengeClaim {
  id: Uuid;
  challengeId: Uuid;
  gameId: Uuid;
  teamId: Uuid;
  playerId: Uuid;
  status: ClaimStatus;
  claimedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  completedAt: IsoTimestamp | null;
  releasedAt: IsoTimestamp | null;
  submission: JsonValue | null;
  locationAtClaim: GeoJsonPoint | null;
  warningSent: boolean;
  createdAt: IsoTimestamp;
}

export interface ResourceLedgerEntry {
  id: Uuid;
  gameId: Uuid;
  teamId: Uuid;
  playerId: Uuid | null;
  resourceType: ResourceType;
  delta: number;
  balanceAfter: number;
  sequence: number;
  reason: string;
  referenceId: Uuid | null;
  referenceType: string | null;
  createdAt: IsoTimestamp;
}

export interface GameEventRecord {
  id: Uuid;
  gameId: Uuid;
  stateVersion: number;
  eventType: GameEventType;
  entityType: EventEntityType;
  entityId: Uuid;
  actorType: EventActorType;
  actorId: Uuid | null;
  actorTeamId: Uuid | null;
  beforeState: JsonValue | null;
  afterState: JsonValue | null;
  meta: JsonObject;
  createdAt: IsoTimestamp;
}

export interface ActionReceipt {
  id: Uuid;
  gameId: Uuid;
  playerId: Uuid | null;
  scopeKey: string;
  actionType: string;
  actionId: string;
  requestHash: string;
  response: JsonValue;
  responseHeaders: JsonObject;
  statusCode: number;
  createdAt: IsoTimestamp;
}

export interface Annotation {
  id: Uuid;
  gameId: Uuid;
  createdBy: Uuid | null;
  type: AnnotationType;
  geometry: GeoJsonGeometry;
  label: string | null;
  style: JsonObject;
  visibility: AnnotationVisibility;
  createdAt: IsoTimestamp;
}

export interface PlayerLocationSample {
  id: number;
  gameId: Uuid;
  playerId: Uuid;
  recordedAt: IsoTimestamp;
  location: GeoJsonPoint;
  gpsErrorMeters: number | null;
  speedMps: number | null;
  headingDegrees: number | null;
  source: PlayerLocationSource;
}

export interface GpsPayload {
  lat: number;
  lng: number;
  gpsErrorMeters: number;
  speedMps: number | null;
  headingDegrees: number | null;
  capturedAt: IsoTimestamp;
}

export type TeamResourceBalances = Partial<Record<ResourceType, number>>;
export type TeamResourcesByTeam = Record<Uuid, TeamResourceBalances>;

export interface GameStateSnapshot {
  game: Game;
  player: Player | null;
  team: Team | null;
  teams: Team[];
  players: Player[];
  teamLocations: TeamLocation[];
  zones: Zone[];
  challenges: Challenge[];
  claims: ChallengeClaim[];
  annotations: Annotation[];
  teamResources: TeamResourcesByTeam;
}

export interface ScoreboardEntry {
  team: Team;
  zoneCount: number;
  resources: TeamResourceBalances;
  rank: number;
}
