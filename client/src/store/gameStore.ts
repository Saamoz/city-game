import {
  socketServerEventTypes,
  type Annotation,
  type Challenge,
  type ChallengeClaim,
  type Game,
  type GameEventRecord,
  type GameStateSnapshot,
  type Player,
  type ResourceLedgerEntry,
  type SocketEventPayloadMap,
  type SocketServerEventType,
  type Team,
  type TeamResourceBalances,
  type TeamResourcesByTeam,
  type Zone,
} from '@city-game/shared';
import { create } from 'zustand';

export type RealtimeConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error';

type DirectRealtimePayload = SocketEventPayloadMap[SocketServerEventType];

type DeltaApplyResult = 'ignored' | 'applied' | 'gap';

type DirectApplyResult = 'ignored' | 'applied';

interface GameStoreState {
  gameId: string | null;
  snapshot: GameStateSnapshot | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  errorMessage: string | null;
  connectionStatus: RealtimeConnectionStatus;
  connectionMessage: string | null;
  setLoading(gameId: string): void;
  initializeSnapshot(gameId: string, snapshot: GameStateSnapshot): void;
  applyRealtimeSync(gameId: string, snapshot: GameStateSnapshot): void;
  applyRealtimeDelta(gameId: string, events: GameEventRecord[]): DeltaApplyResult;
  applyRealtimePayload(gameId: string, eventType: SocketServerEventType, payload: DirectRealtimePayload): DirectApplyResult;
  setError(gameId: string, errorMessage: string): void;
  setConnectionState(status: RealtimeConnectionStatus, message?: string | null): void;
  reset(): void;
}

export const useGameStore = create<GameStoreState>((set) => ({
  gameId: null,
  snapshot: null,
  status: 'idle',
  errorMessage: null,
  connectionStatus: 'idle',
  connectionMessage: null,
  setLoading: (gameId) =>
    set({
      gameId,
      snapshot: null,
      status: 'loading',
      errorMessage: null,
      connectionStatus: 'idle',
      connectionMessage: null,
    }),
  initializeSnapshot: (gameId, snapshot) =>
    set({
      gameId,
      snapshot,
      status: 'ready',
      errorMessage: null,
    }),
  applyRealtimeSync: (gameId, snapshot) =>
    set((state) => {
      if (state.gameId !== gameId) {
        return state;
      }

      return {
        ...state,
        snapshot,
        status: 'ready',
        errorMessage: null,
      };
    }),
  applyRealtimeDelta: (gameId, events) => {
    let result: DeltaApplyResult = 'ignored';

    set((state) => {
      if (state.gameId !== gameId || !state.snapshot || events.length === 0) {
        return state;
      }

      let nextSnapshot = cloneSnapshot(state.snapshot);
      let currentVersion = nextSnapshot.game.stateVersion;
      let applied = false;

      for (const event of events) {
        if (event.stateVersion < currentVersion) {
          continue;
        }

        if (event.stateVersion > currentVersion + 1) {
          result = 'gap';
          return state;
        }

        nextSnapshot = applyGameEventRecord(nextSnapshot, event);
        if (event.stateVersion > currentVersion) {
          currentVersion = event.stateVersion;
        }

        nextSnapshot.game = {
          ...nextSnapshot.game,
          stateVersion: currentVersion,
        };
        applied = true;
      }

      if (!applied) {
        return state;
      }

      result = 'applied';
      return {
        ...state,
        snapshot: nextSnapshot,
        status: 'ready',
        errorMessage: null,
      };
    });

    return result;
  },
  applyRealtimePayload: (gameId, eventType, payload) => {
    let result: DirectApplyResult = 'ignored';

    set((state) => {
      if (state.gameId !== gameId || !state.snapshot) {
        return state;
      }

      const nextSnapshot = applyDirectRealtimePayload(cloneSnapshot(state.snapshot), eventType, payload);
      if (!nextSnapshot) {
        return state;
      }

      result = 'applied';
      return {
        ...state,
        snapshot: nextSnapshot,
        status: 'ready',
        errorMessage: null,
      };
    });

    return result;
  },
  setError: (gameId, errorMessage) =>
    set({
      gameId,
      snapshot: null,
      status: 'error',
      errorMessage,
      connectionStatus: 'idle',
      connectionMessage: null,
    }),
  setConnectionState: (connectionStatus, connectionMessage = null) =>
    set((state) => ({
      ...state,
      connectionStatus,
      connectionMessage,
    })),
  reset: () =>
    set({
      gameId: null,
      snapshot: null,
      status: 'idle',
      errorMessage: null,
      connectionStatus: 'idle',
      connectionMessage: null,
    }),
}));

function applyGameEventRecord(snapshot: GameStateSnapshot, event: GameEventRecord): GameStateSnapshot {
  switch (event.eventType) {
    case 'GAME_STARTED':
    case 'GAME_PAUSED':
    case 'GAME_RESUMED':
    case 'GAME_ENDED': {
      const game = asGame(event.meta.game) ?? asGame(event.afterState);
      if (!game) {
        return snapshot;
      }

      snapshot.game = game;
      return snapshot;
    }
    case 'OBJECTIVE_STATE_CHANGED': {
      const challenge = asChallenge(event.meta.challenge);
      const claim = asChallengeClaim(event.meta.claim);

      if (challenge) {
        snapshot.challenges = upsertById(snapshot.challenges, challenge);
      }

      if (claim) {
        snapshot.claims = upsertById(snapshot.claims, claim);
      }

      return snapshot;
    }
    case 'CONTROL_STATE_CHANGED':
    case 'ZONE_CAPTURED': {
      const zone = asZone(event.meta.zone) ?? asZone(event.afterState);
      const challenge = asChallenge(event.meta.challenge);
      const claim = asChallengeClaim(event.meta.claim);

      if (zone) {
        snapshot.zones = upsertById(snapshot.zones, zone);
      }

      if (challenge) {
        snapshot.challenges = upsertById(snapshot.challenges, challenge);
      }

      if (claim) {
        snapshot.claims = upsertById(snapshot.claims, claim);
      }

      return snapshot;
    }
    case 'RESOURCE_CHANGED': {
      const entry = asResourceLedgerEntry(event.meta.entry) ?? asResourceLedgerEntry(event.afterState);
      if (!entry) {
        return snapshot;
      }

      snapshot.teamResources = setTeamResourceBalance(
        snapshot.teamResources,
        entry.teamId,
        entry.resourceType,
        entry.balanceAfter,
      );
      return snapshot;
    }
    case 'ANNOTATION_ADDED': {
      const annotation = asAnnotation(event.meta.annotation) ?? asAnnotation(event.afterState);
      if (!annotation) {
        return snapshot;
      }

      snapshot.annotations = upsertById(snapshot.annotations, annotation);
      return snapshot;
    }
    case 'ANNOTATION_REMOVED': {
      const annotationId = asString(event.meta.annotationId) ?? event.entityId;
      snapshot.annotations = removeById(snapshot.annotations, annotationId);
      return snapshot;
    }
    case 'CHALLENGE_CLAIMED':
    case 'CHALLENGE_RELEASED':
    case 'CHALLENGE_COMPLETED':
    case 'CHALLENGE_SPAWNED': {
      const challenge = asChallenge(event.meta.challenge);
      const claim = asChallengeClaim(event.meta.claim) ?? asChallengeClaim(event.afterState);
      const zone = asZone(event.meta.zone);

      if (challenge) {
        snapshot.challenges = upsertById(snapshot.challenges, challenge);
      }

      if (claim) {
        snapshot.claims = upsertById(snapshot.claims, claim);
      }

      if (zone) {
        snapshot.zones = upsertById(snapshot.zones, zone);
      }

      return snapshot;
    }
    default:
      return snapshot;
  }
}

function applyDirectRealtimePayload(
  snapshot: GameStateSnapshot,
  eventType: SocketServerEventType,
  payload: DirectRealtimePayload,
): GameStateSnapshot | null {
  switch (eventType) {
    case socketServerEventTypes.gameStateSync:
    case socketServerEventTypes.gameStateDelta:
      return null;
    case socketServerEventTypes.gameStarted:
    case socketServerEventTypes.gamePaused:
    case socketServerEventTypes.gameResumed:
    case socketServerEventTypes.gameEnded: {
      const lifecyclePayload = payload as SocketEventPayloadMap['game_started'];
      snapshot.game = lifecyclePayload.game;
      snapshot.game = {
        ...snapshot.game,
        stateVersion: lifecyclePayload.stateVersion,
      };
      return snapshot;
    }
    case socketServerEventTypes.playerJoined: {
      const joinedPayload = payload as SocketEventPayloadMap['player_joined'];
      snapshot.players = upsertById(snapshot.players, joinedPayload.player);
      if (joinedPayload.team) {
        snapshot.teams = upsertById(snapshot.teams, joinedPayload.team);
      }
      if (snapshot.player?.id === joinedPayload.player.id) {
        snapshot.player = joinedPayload.player;
        snapshot.team = joinedPayload.team;
      }
      snapshot.game = {
        ...snapshot.game,
        stateVersion: joinedPayload.stateVersion,
      };
      return snapshot;
    }
    case socketServerEventTypes.annotationAdded: {
      const annotationPayload = payload as SocketEventPayloadMap['annotation_added'];
      snapshot.annotations = upsertById(snapshot.annotations, annotationPayload.annotation);
      snapshot.game = {
        ...snapshot.game,
        stateVersion: annotationPayload.stateVersion,
      };
      return snapshot;
    }
    case socketServerEventTypes.annotationRemoved: {
      const removedPayload = payload as SocketEventPayloadMap['annotation_removed'];
      snapshot.annotations = removeById(snapshot.annotations, removedPayload.annotationId);
      snapshot.game = {
        ...snapshot.game,
        stateVersion: removedPayload.stateVersion,
      };
      return snapshot;
    }
    case socketServerEventTypes.resourceChanged: {
      const resourcePayload = payload as SocketEventPayloadMap['resource_changed'];
      snapshot.teamResources = setTeamResourceBalance(
        snapshot.teamResources,
        resourcePayload.teamId,
        resourcePayload.resourceType,
        resourcePayload.balance,
      );
      snapshot.game = {
        ...snapshot.game,
        stateVersion: resourcePayload.stateVersion,
      };
      return snapshot;
    }
    case socketServerEventTypes.zoneCaptured: {
      const zonePayload = payload as SocketEventPayloadMap['zone_captured'];
      snapshot.zones = upsertById(snapshot.zones, zonePayload.zone);
      snapshot.challenges = upsertById(snapshot.challenges, zonePayload.challenge);
      snapshot.claims = upsertById(snapshot.claims, zonePayload.claim);
      snapshot.game = {
        ...snapshot.game,
        stateVersion: zonePayload.stateVersion,
      };
      return snapshot;
    }
    case socketServerEventTypes.challengeClaimed: {
      const claimedPayload = payload as SocketEventPayloadMap['challenge_claimed'];
      snapshot.challenges = upsertById(snapshot.challenges, claimedPayload.challenge);
      snapshot.claims = upsertById(snapshot.claims, claimedPayload.claim);
      snapshot.game = {
        ...snapshot.game,
        stateVersion: claimedPayload.stateVersion,
      };
      return snapshot;
    }
    case socketServerEventTypes.challengeCompleted: {
      const completedPayload = payload as SocketEventPayloadMap['challenge_completed'];
      snapshot.challenges = upsertById(snapshot.challenges, completedPayload.challenge);
      snapshot.claims = upsertById(snapshot.claims, completedPayload.claim);
      if (completedPayload.zone) {
        snapshot.zones = upsertById(snapshot.zones, completedPayload.zone);
      }
      snapshot.game = {
        ...snapshot.game,
        stateVersion: completedPayload.stateVersion,
      };
      return snapshot;
    }
    case socketServerEventTypes.challengeReleased: {
      const releasedPayload = payload as SocketEventPayloadMap['challenge_released'];
      snapshot.challenges = upsertById(snapshot.challenges, releasedPayload.challenge);
      snapshot.claims = upsertById(snapshot.claims, releasedPayload.claim);
      snapshot.game = {
        ...snapshot.game,
        stateVersion: releasedPayload.stateVersion,
      };
      return snapshot;
    }
    case socketServerEventTypes.challengeSpawned: {
      const spawnedPayload = payload as SocketEventPayloadMap['challenge_spawned'];
      snapshot.challenges = upsertById(snapshot.challenges, spawnedPayload.challenge);
      if (spawnedPayload.zone) {
        snapshot.zones = upsertById(snapshot.zones, spawnedPayload.zone);
      }
      snapshot.game = {
        ...snapshot.game,
        stateVersion: spawnedPayload.stateVersion,
      };
      return snapshot;
    }
    default:
      return snapshot;
  }
}

function cloneSnapshot(snapshot: GameStateSnapshot): GameStateSnapshot {
  return {
    ...snapshot,
    game: { ...snapshot.game },
    player: snapshot.player ? { ...snapshot.player } : null,
    team: snapshot.team ? { ...snapshot.team } : null,
    teams: [...snapshot.teams],
    players: [...snapshot.players],
    zones: [...snapshot.zones],
    challenges: [...snapshot.challenges],
    claims: [...snapshot.claims],
    annotations: [...snapshot.annotations],
    teamResources: cloneTeamResources(snapshot.teamResources),
  };
}

function cloneTeamResources(teamResources: TeamResourcesByTeam): TeamResourcesByTeam {
  return Object.fromEntries(
    Object.entries(teamResources).map(([teamId, balances]) => [teamId, { ...balances }]),
  ) as TeamResourcesByTeam;
}

function setTeamResourceBalance(
  teamResources: TeamResourcesByTeam,
  teamId: string,
  resourceType: string,
  balance: number,
): TeamResourcesByTeam {
  const nextBalances: TeamResourceBalances = {
    ...(teamResources[teamId] ?? {}),
    [resourceType]: balance,
  };

  return {
    ...teamResources,
    [teamId]: nextBalances,
  };
}

function upsertById<TItem extends { id: string }>(items: TItem[], item: TItem): TItem[] {
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index === -1) {
    return [...items, item];
  }

  const nextItems = [...items];
  nextItems[index] = item;
  return nextItems;
}

function removeById<TItem extends { id: string }>(items: TItem[], itemId: string): TItem[] {
  return items.filter((entry) => entry.id !== itemId);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asGame(value: unknown): Game | null {
  return isObjectWithId(value) ? (value as Game) : null;
}

function asTeam(value: unknown): Team | null {
  return isObjectWithId(value) ? (value as Team) : null;
}

function asPlayer(value: unknown): Player | null {
  return isObjectWithId(value) ? (value as Player) : null;
}

function asZone(value: unknown): Zone | null {
  return isObjectWithId(value) ? (value as Zone) : null;
}

function asChallenge(value: unknown): Challenge | null {
  return isObjectWithId(value) ? (value as Challenge) : null;
}

function asChallengeClaim(value: unknown): ChallengeClaim | null {
  return isObjectWithId(value) ? (value as ChallengeClaim) : null;
}

function asAnnotation(value: unknown): Annotation | null {
  return isObjectWithId(value) ? (value as Annotation) : null;
}

function asResourceLedgerEntry(value: unknown): ResourceLedgerEntry | null {
  return isObjectWithId(value) ? (value as ResourceLedgerEntry) : null;
}

function isObjectWithId(value: unknown): value is { id: string } {
  return typeof value === 'object' && value !== null && 'id' in value && typeof (value as { id: unknown }).id === 'string';
}
