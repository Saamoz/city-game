import type { ResourceType } from './resources.js';
import type {
  Annotation,
  Challenge,
  ChallengeClaim,
  Game,
  GameEventRecord,
  GameStateSnapshot,
  IsoTimestamp,
  Player,
  ResourceAwardMap,
  ResourceLedgerEntry,
  Team,
  Zone,
} from './types.js';

export const engineEventTypes = {
  gameStarted: 'GAME_STARTED',
  gamePaused: 'GAME_PAUSED',
  gameResumed: 'GAME_RESUMED',
  gameEnded: 'GAME_ENDED',
  playerJoined: 'PLAYER_JOINED',
  objectiveStateChanged: 'OBJECTIVE_STATE_CHANGED',
  resourceChanged: 'RESOURCE_CHANGED',
  controlStateChanged: 'CONTROL_STATE_CHANGED',
  annotationAdded: 'ANNOTATION_ADDED',
  annotationRemoved: 'ANNOTATION_REMOVED',
  adminOverride: 'ADMIN_OVERRIDE',
} as const;

export const territoryEventTypes = {
  zoneCaptured: 'ZONE_CAPTURED',
  challengeClaimed: 'CHALLENGE_CLAIMED',
  challengeReleased: 'CHALLENGE_RELEASED',
  challengeCompleted: 'CHALLENGE_COMPLETED',
  challengeSpawned: 'CHALLENGE_SPAWNED',
} as const;

export const eventTypes = {
  ...engineEventTypes,
  ...territoryEventTypes,
} as const;

export type EngineEventType = (typeof engineEventTypes)[keyof typeof engineEventTypes];
export type TerritoryEventType = (typeof territoryEventTypes)[keyof typeof territoryEventTypes];
export type GameEventType = EngineEventType | TerritoryEventType;
export const EVENT_TYPE_VALUES = Object.values(eventTypes) as GameEventType[];

export const socketServerEventTypes = {
  gameStateSync: 'game_state_sync',
  gameStateDelta: 'game_state_delta',
  gameStarted: 'game_started',
  gamePaused: 'game_paused',
  gameResumed: 'game_resumed',
  gameEnded: 'game_ended',
  playerJoined: 'player_joined',
  annotationAdded: 'annotation_added',
  annotationRemoved: 'annotation_removed',
  resourceChanged: 'resource_changed',
  zoneCaptured: 'zone_captured',
  challengeClaimed: 'challenge_claimed',
  challengeCompleted: 'challenge_completed',
  challengeReleased: 'challenge_released',
  challengeSpawned: 'challenge_spawned',
} as const;

export const socketClientEventTypes = {
  joinGame: 'join_game',
  leaveGame: 'leave_game',
} as const;

export type SocketServerEventType =
  (typeof socketServerEventTypes)[keyof typeof socketServerEventTypes];
export type SocketClientEventType =
  (typeof socketClientEventTypes)[keyof typeof socketClientEventTypes];
export type SocketEventType = SocketServerEventType | SocketClientEventType;

export interface BroadcastEnvelopeBase {
  gameId: string;
  stateVersion: number;
  serverTime: IsoTimestamp;
}

export interface JoinGamePayload {
  gameId: string;
  lastStateVersion?: number;
}

export interface LeaveGamePayload {
  gameId: string;
}

export interface GameStateSyncPayload extends BroadcastEnvelopeBase {
  snapshot: GameStateSnapshot;
}

export interface GameStateDeltaPayload extends BroadcastEnvelopeBase {
  events: GameEventRecord[];
  fullSyncRequired?: boolean;
}

export interface GameLifecyclePayload extends BroadcastEnvelopeBase {
  game: Game;
}

export interface PlayerJoinedPayload extends BroadcastEnvelopeBase {
  player: Player;
  team: Team | null;
}

export interface AnnotationAddedPayload extends BroadcastEnvelopeBase {
  annotation: Annotation;
}

export interface AnnotationRemovedPayload extends BroadcastEnvelopeBase {
  annotationId: string;
}

export interface ResourceChangedPayload extends BroadcastEnvelopeBase {
  teamId: string;
  resourceType: ResourceType;
  balance: number;
  delta: number;
  entry: ResourceLedgerEntry;
}

export interface ZoneCapturedPayload extends BroadcastEnvelopeBase {
  zone: Zone;
  challenge: Challenge;
  claim: ChallengeClaim;
}

export interface ChallengeClaimedPayload extends BroadcastEnvelopeBase {
  challenge: Challenge;
  claim: ChallengeClaim;
}

export interface ChallengeCompletedPayload extends BroadcastEnvelopeBase {
  challenge: Challenge;
  claim: ChallengeClaim;
  zone: Zone | null;
  resourcesAwarded: ResourceAwardMap;
}

export interface ChallengeReleasedPayload extends BroadcastEnvelopeBase {
  challenge: Challenge;
  claim: ChallengeClaim;
}

export interface ChallengeSpawnedPayload extends BroadcastEnvelopeBase {
  challenge: Challenge;
  zone: Zone | null;
}

export interface EngineEventPayloadMap {
  GAME_STARTED: { game: Game };
  GAME_PAUSED: { game: Game };
  GAME_RESUMED: { game: Game };
  GAME_ENDED: { game: Game };
  PLAYER_JOINED: { player: Player; team: Team | null };
  OBJECTIVE_STATE_CHANGED: { challenge: Challenge; claim: ChallengeClaim | null };
  RESOURCE_CHANGED: { entry: ResourceLedgerEntry };
  CONTROL_STATE_CHANGED: { zone: Zone };
  ANNOTATION_ADDED: { annotation: Annotation };
  ANNOTATION_REMOVED: { annotationId: string };
  ADMIN_OVERRIDE: { action: string; targetId?: string; notes?: string };
}

export interface TerritoryEventPayloadMap {
  ZONE_CAPTURED: { zone: Zone; challenge: Challenge; claim: ChallengeClaim };
  CHALLENGE_CLAIMED: { challenge: Challenge; claim: ChallengeClaim };
  CHALLENGE_RELEASED: { challenge: Challenge; claim: ChallengeClaim };
  CHALLENGE_COMPLETED: {
    challenge: Challenge;
    claim: ChallengeClaim;
    zone: Zone | null;
    resourcesAwarded: ResourceAwardMap;
  };
  CHALLENGE_SPAWNED: { challenge: Challenge; zone: Zone | null };
}

export type GameEventPayloadMap = EngineEventPayloadMap & TerritoryEventPayloadMap;
export type GameEventPayload<TEvent extends GameEventType> = GameEventPayloadMap[TEvent];

export interface SocketEventPayloadMap {
  game_state_sync: GameStateSyncPayload;
  game_state_delta: GameStateDeltaPayload;
  game_started: GameLifecyclePayload;
  game_paused: GameLifecyclePayload;
  game_resumed: GameLifecyclePayload;
  game_ended: GameLifecyclePayload;
  player_joined: PlayerJoinedPayload;
  annotation_added: AnnotationAddedPayload;
  annotation_removed: AnnotationRemovedPayload;
  resource_changed: ResourceChangedPayload;
  zone_captured: ZoneCapturedPayload;
  challenge_claimed: ChallengeClaimedPayload;
  challenge_completed: ChallengeCompletedPayload;
  challenge_released: ChallengeReleasedPayload;
  challenge_spawned: ChallengeSpawnedPayload;
  join_game: JoinGamePayload;
  leave_game: LeaveGamePayload;
}

export type SocketEventPayload<TEvent extends SocketEventType> = SocketEventPayloadMap[TEvent];
