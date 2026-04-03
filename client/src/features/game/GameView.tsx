import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  socketServerEventTypes,
  type ChallengeClaim,
  type GameStateSnapshot,
  type SocketEventPayloadMap,
  type SocketServerEventType,
} from '@city-game/shared';
import {
  ApiError,
  completeChallenge,
  getMapState,
  type CompleteChallengeResponse,
} from '../../lib/api';
import {
  buildRealtimePayloadKey,
  createRealtimeSocket,
  directRealtimeEventTypes,
  joinRealtimeGame,
  leaveRealtimeGame,
} from '../../lib/realtime';
import { useGameStore, type RealtimeConnectionStatus } from '../../store/gameStore';
import { ChallengeDeck } from './ChallengeDeck';
import { ZoneLayer } from './ZoneLayer';
import { collectGeometryPositions, findContainingZone } from './mapGeometry';
import { useGeolocation } from './useGeolocation';
import { useIdempotentAction } from './useIdempotentAction';

interface GameViewProps {
  gameId: string;
  onLeaveMap(): void;
}

interface ToastMessage {
  tone: 'success' | 'error';
  title: string;
  body?: string;
}

const mapboxToken = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? import.meta.env.MAPBOX_ACCESS_TOKEN ?? '').trim();

export function GameView({ gameId, onLeaveMap }: GameViewProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const didFitBoundsRef = useRef(false);
  const fullSyncAbortRef = useRef<AbortController | null>(null);
  const appliedRealtimeKeysRef = useRef<Map<number, Set<string>>>(new Map());
  const hasConnectedRef = useRef(false);
  const locationMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const [mapForLayer, setMapForLayer] = useState<mapboxgl.Map | null>(null);
  const [selectedChallengeId, setSelectedChallengeId] = useState<string | null>(null);
  const [isDeckOpen, setIsDeckOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showMobileCompleted, setShowMobileCompleted] = useState(false);
  const [deckDragY, setDeckDragY] = useState(0);
  const [isDraggingDeck, setIsDraggingDeck] = useState(false);
  const deckSwipeRef = useRef({ active: false, startX: 0, startY: 0, startTime: 0, committed: false });
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const snapshot = useGameStore((state) => state.snapshot);
  const status = useGameStore((state) => state.status);
  const errorMessage = useGameStore((state) => state.errorMessage);
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const connectionMessage = useGameStore((state) => state.connectionMessage);
  const setLoading = useGameStore((state) => state.setLoading);
  const initializeSnapshot = useGameStore((state) => state.initializeSnapshot);
  const applyRealtimeSync = useGameStore((state) => state.applyRealtimeSync);
  const applyRealtimeDelta = useGameStore((state) => state.applyRealtimeDelta);
  const applyRealtimePayload = useGameStore((state) => state.applyRealtimePayload);
  const setError = useGameStore((state) => state.setError);
  const setConnectionState = useGameStore((state) => state.setConnectionState);
  const reset = useGameStore((state) => state.reset);

  const { status: locationStatus, gpsPayload, errorMessage: locationErrorMessage, refresh: refreshLocation } = useGeolocation();
  const { runAction, isPending } = useIdempotentAction();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(gameId);
    setSelectedChallengeId(null);

    void getMapState(gameId, controller.signal)
      .then((nextSnapshot) => {
        initializeSnapshot(gameId, nextSnapshot);
      })
      .catch((error) => {
        if (isAbortError(error)) {
          return;
        }

        setError(gameId, getGameViewError(error));
      });

    return () => {
      controller.abort();
      reset();
    };
  }, [gameId, initializeSnapshot, reset, setError, setLoading]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const canStartRealtime = status === 'ready' && Boolean(snapshot);

  useEffect(() => {
    if (!canStartRealtime) {
      return;
    }

    const socket = createRealtimeSocket();
    hasConnectedRef.current = false;
    appliedRealtimeKeysRef.current.clear();
    setConnectionState('connecting', 'Connecting live feed.');

    const requestFullSync = async (message: string) => {
      fullSyncAbortRef.current?.abort();
      const controller = new AbortController();
      fullSyncAbortRef.current = controller;
      setConnectionState('reconnecting', message);

      try {
        const nextSnapshot = await getMapState(gameId, controller.signal);
        if (controller.signal.aborted) {
          return;
        }

        applyRealtimeSync(gameId, nextSnapshot);
        pruneRealtimeKeys(appliedRealtimeKeysRef.current, nextSnapshot.game.stateVersion);
        setConnectionState(socket.connected ? 'live' : 'reconnecting', socket.connected ? null : message);
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }

        setConnectionState('error', getRealtimeErrorMessage(error));
      }
    };

    const connectToGame = () => {
      const currentVersion = useGameStore.getState().snapshot?.game.stateVersion;
      const isReconnect = hasConnectedRef.current;

      setConnectionState(
        isReconnect ? 'reconnecting' : 'connecting',
        isReconnect ? 'Socket reconnected. Catching up live state.' : 'Joining live feed.',
      );

      joinRealtimeGame(socket, gameId, currentVersion, (response) => {
        if (!isJoinAckSuccess(response)) {
          setConnectionState('error', getJoinAckErrorMessage(response));
          return;
        }

        hasConnectedRef.current = true;
        setConnectionState('live', null);
      });
    };

    const handleSync = (payload: SocketEventPayloadMap['game_state_sync']) => {
      if (payload.gameId !== gameId) {
        return;
      }

      appliedRealtimeKeysRef.current.clear();
      applyRealtimeSync(gameId, payload.snapshot);
      pruneRealtimeKeys(appliedRealtimeKeysRef.current, payload.stateVersion);
      setConnectionState('live', null);
    };

    const handleDelta = (payload: SocketEventPayloadMap['game_state_delta']) => {
      if (payload.gameId !== gameId) {
        return;
      }

      if (payload.fullSyncRequired) {
        void requestFullSync('Live feed fell behind. Refreshing full state.');
        return;
      }

      const result = applyRealtimeDelta(gameId, payload.events);
      if (result === 'gap') {
        void requestFullSync('Version gap detected. Refreshing full state.');
        return;
      }

      if (result === 'applied') {
        const currentVersion = useGameStore.getState().snapshot?.game.stateVersion ?? payload.stateVersion;
        pruneRealtimeKeys(appliedRealtimeKeysRef.current, currentVersion);
        setConnectionState('live', null);
      }
    };

    const directHandlers = new Map<SocketServerEventType, (payload: SocketEventPayloadMap[SocketServerEventType]) => void>();

    for (const eventType of directRealtimeEventTypes) {
      const handler = (payload: SocketEventPayloadMap[typeof eventType]) => {
        if (payload.gameId !== gameId) {
          return;
        }

        const currentVersion = useGameStore.getState().snapshot?.game.stateVersion ?? 0;
        if (payload.stateVersion < currentVersion) {
          return;
        }

        if (payload.stateVersion > currentVersion + 1) {
          void requestFullSync('Live feed missed updates. Refreshing full state.');
          return;
        }

        const payloadKey = buildRealtimePayloadKey(eventType, payload);
        const versionKeys = appliedRealtimeKeysRef.current.get(payload.stateVersion) ?? new Set<string>();
        if (versionKeys.has(payloadKey)) {
          return;
        }

        const result = applyRealtimePayload(gameId, eventType, payload);
        if (result !== 'applied') {
          return;
        }

        versionKeys.add(payloadKey);
        appliedRealtimeKeysRef.current.set(payload.stateVersion, versionKeys);
        const nextVersion = useGameStore.getState().snapshot?.game.stateVersion ?? payload.stateVersion;
        pruneRealtimeKeys(appliedRealtimeKeysRef.current, nextVersion);
        setConnectionState('live', null);
      };

      directHandlers.set(eventType, handler as (payload: SocketEventPayloadMap[SocketServerEventType]) => void);
      socket.on(eventType, handler);
    }

    const handleConnectError = (error: Error) => {
      setConnectionState(
        socket.active ? 'reconnecting' : 'error',
        socket.active ? 'Unable to reach the live feed. Retrying.' : error.message || 'Failed to connect to the live feed.',
      );
    };

    const handleDisconnect = (reason: string) => {
      if (reason === 'io client disconnect') {
        setConnectionState('idle', null);
        return;
      }

      setConnectionState('reconnecting', 'Live feed disconnected (' + formatSocketReason(reason) + ').');
    };

    const handleReconnectAttempt = () => {
      setConnectionState('reconnecting', 'Reconnecting live feed.');
    };

    const handleReconnectError = (error: Error) => {
      setConnectionState('reconnecting', 'Reconnect failed: ' + error.message);
    };

    socket.on('connect', connectToGame);
    socket.on('connect_error', handleConnectError);
    socket.on('disconnect', handleDisconnect);
    socket.on(socketServerEventTypes.gameStateSync, handleSync);
    socket.on(socketServerEventTypes.gameStateDelta, handleDelta);
    socket.io.on('reconnect_attempt', handleReconnectAttempt);
    socket.io.on('reconnect_error', handleReconnectError);
    socket.connect();

    return () => {
      fullSyncAbortRef.current?.abort();
      fullSyncAbortRef.current = null;
      appliedRealtimeKeysRef.current.clear();
      socket.off('connect', connectToGame);
      socket.off('connect_error', handleConnectError);
      socket.off('disconnect', handleDisconnect);
      socket.off(socketServerEventTypes.gameStateSync, handleSync);
      socket.off(socketServerEventTypes.gameStateDelta, handleDelta);
      socket.io.off('reconnect_attempt', handleReconnectAttempt);
      socket.io.off('reconnect_error', handleReconnectError);

      for (const [eventType, handler] of directHandlers) {
        socket.off(eventType, handler);
      }

      if (socket.connected) {
        leaveRealtimeGame(socket, gameId);
      }

      socket.disconnect();
      setConnectionState('idle', null);
    };
  }, [
    canStartRealtime,
    gameId,
    applyRealtimeDelta,
    applyRealtimePayload,
    applyRealtimeSync,
    setConnectionState,
  ]);

  useEffect(() => {
    if (!snapshot || !mapContainerRef.current || !mapboxToken || mapRef.current) {
      return;
    }

    mapboxgl.accessToken = mapboxToken;
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/saamoz/cmng3j80c004001s831aw5e3b',
      center: [snapshot.game.centerLng, snapshot.game.centerLat],
      zoom: snapshot.game.defaultZoom,
      pitchWithRotate: false,
      attributionControl: false,
      performanceMetricsCollection: false,
    });

    mapRef.current = map;
    setMapForLayer(map);

    return () => {
      didFitBoundsRef.current = false;
      locationMarkerRef.current?.remove();
      locationMarkerRef.current = null;
      setMapForLayer(null);
      mapRef.current = null;
      map.remove();
    };
  }, [snapshot?.game.id]);

  useEffect(() => {
    const map = mapRef.current;
    if (!snapshot || !map || didFitBoundsRef.current) {
      return;
    }

    const bounds = getBoundsFromSnapshot(snapshot);
    if (bounds) {
      map.fitBounds(bounds, {
        padding: 88,
        duration: 0,
      });
    }

    didFitBoundsRef.current = true;
  }, [snapshot]);

  useEffect(() => {
    const availableChallenges = snapshot?.challenges.filter((challenge) => challenge.status === 'available') ?? [];

    if (!availableChallenges.length) {
      setSelectedChallengeId(null);
      return;
    }

    if (selectedChallengeId && availableChallenges.some((challenge) => challenge.id === selectedChallengeId)) {
      return;
    }

    const nextChallenge = [...availableChallenges].sort((left, right) => left.title.localeCompare(right.title))[0] ?? null;
    setSelectedChallengeId(nextChallenge?.id ?? null);
  }, [selectedChallengeId, snapshot]);

  const missingToken = mapboxToken.length === 0;
  const team = snapshot?.team ?? null;
  const challengeCounts = useMemo(() => buildChallengeCounts(snapshot), [snapshot]);
  const completedCards = useMemo(() => buildCompletedCards(snapshot), [snapshot]);
  const controlledZoneCount = useMemo(() => buildControlledZoneCount(snapshot, team?.id ?? null), [snapshot, team?.id]);
  const currentPoint = gpsPayload ? [gpsPayload.lng, gpsPayload.lat] as [number, number] : null;
  const currentZone = useMemo(() => snapshot ? findContainingZone(snapshot.zones, currentPoint) : null, [currentPoint, snapshot]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || !currentPoint) {
      locationMarkerRef.current?.remove();
      locationMarkerRef.current = null;
      return;
    }

    if (!locationMarkerRef.current) {
      locationMarkerRef.current = new mapboxgl.Marker({ element: createCurrentLocationMarkerElement() })
        .setLngLat(currentPoint)
        .addTo(map);
      return;
    }

    locationMarkerRef.current.setLngLat(currentPoint);
  }, [currentPoint]);

  const handleCaptureChallenge = (challengeId: string) => {
    void runAction(`capture:${challengeId}`, async (idempotencyKey) => {
      const challenge = snapshot?.challenges.find((entry) => entry.id === challengeId) ?? null;
      const zoneLabel = currentZone?.name ?? 'this zone';

      if (!challenge) {
        return null;
      }

      const attemptCapture = async (gpsCapturedAtOverride?: string) => {
        const gps = gpsPayload ?? await refreshLocation();
        const response = await completeChallenge(
          challengeId,
          {
            gps: gpsCapturedAtOverride ? { ...gps, capturedAt: gpsCapturedAtOverride } : gps,
          },
          idempotencyKey,
        );
        applyCompletedMutation(gameId, response);
        setToast({
          tone: 'success',
          title: response.zone ? `${response.zone.name} captured` : 'Challenge completed',
        });
        return response;
      };

      try {
        return await attemptCapture();
      } catch (error) {
        if (error instanceof ApiError && error.code === 'GPS_TOO_OLD') {
          const override = window.confirm('GPS reading is too old. Use it anyway?');
          if (!override) {
            return null;
          }

          try {
            return await attemptCapture(new Date().toISOString());
          } catch (retryError) {
            setToast({
              tone: 'error',
              title: 'Claim failed',
              body: getMutationErrorMessage(retryError),
            });
            throw retryError;
          }
        }

        setToast({
          tone: 'error',
          title: 'Claim failed',
          body: getMutationErrorMessage(error),
        });
        throw error;
      }
    });
  };

  const handleDeckPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest('[data-deck-interactive="true"]')) {
      return;
    }
    deckSwipeRef.current = { active: true, startX: e.clientX, startY: e.clientY, startTime: Date.now(), committed: false };
  }, []);

  const handleDeckPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const ref = deckSwipeRef.current;
    if (!ref.active) {
      return;
    }
    const deltaX = e.clientX - ref.startX;
    const deltaY = e.clientY - ref.startY;
    if (!ref.committed) {
      if (Math.abs(deltaX) > 10) {
        deckSwipeRef.current.active = false;
        return;
      }
      if (Math.abs(deltaY) > 10) {
        deckSwipeRef.current.committed = true;
        setIsDraggingDeck(true);
      }
      return;
    }
    // Prevent browser from scrolling the page/viewport during a committed vertical swipe
    e.preventDefault();
    // Resist upward drag
    setDeckDragY(deltaY > 0 ? deltaY : Math.round(deltaY * 0.25));
  }, []);

  const handleDeckPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>, currentShowCompleted: boolean, hasCompleted: boolean) => {
    const ref = deckSwipeRef.current;
    if (!ref.active) {
      return;
    }
    deckSwipeRef.current.active = false;
    setIsDraggingDeck(false);
    const deltaY = e.clientY - ref.startY;
    const velocity = deltaY / Math.max(Date.now() - ref.startTime, 1);

    if (deltaY > 80 || (deltaY > 30 && velocity > 0.5)) {
      if (currentShowCompleted) {
        setShowMobileCompleted(false);
        setDeckDragY(0);
      } else {
        setDeckDragY(500);
        window.setTimeout(() => {
          startTransition(() => setIsDeckOpen(false));
          setShowMobileCompleted(false);
          setDeckDragY(0);
        }, 400);
      }
    } else if (deltaY < -50 || (deltaY < -20 && velocity < -0.4)) {
      if (!currentShowCompleted && hasCompleted) {
        setShowMobileCompleted(true);
      }
      setDeckDragY(0);
    } else {
      setDeckDragY(0);
    }
  }, []);

  const handleDeckPointerCancel = useCallback(() => {
    deckSwipeRef.current.active = false;
    setIsDraggingDeck(false);
    setDeckDragY(0);
  }, []);

  return (
    <main className="relative h-screen overflow-hidden bg-[#dfe6e8] text-[#1f2a2f]">
      <div ref={mapContainerRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(244,234,215,0.16),transparent_28%),linear-gradient(180deg,rgba(223,230,232,0.04),rgba(223,230,232,0.16))]" />
      <ZoneLayer map={mapForLayer} snapshot={snapshot} />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-[linear-gradient(180deg,rgba(243,236,220,0.9),rgba(243,236,220,0))] px-4 pb-10 pt-4 sm:px-6 lg:px-8">
        <div className="pointer-events-auto mx-auto max-w-7xl">

          {/* Mobile top bar: zone pill + menu button */}
          <div className="sm:hidden flex items-center justify-between">
            {currentZone ? (
              <span className="rounded-full border border-[#c8b48a]/55 bg-[#f3ecd8]/90 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#24343a] backdrop-blur-sm">
                {currentZone.name}
              </span>
            ) : <span />}
            <button
              className="flex h-9 w-9 items-center justify-center rounded-full border border-[#c9ae6d]/55 bg-[#f3ecd8]/90 text-sm text-[#24343a] shadow-sm backdrop-blur-sm"
              onClick={() => setIsMenuOpen(true)}
              type="button"
              aria-label="Menu"
            >
              ☰
            </button>
          </div>

          {/* Desktop HUD */}
          <div className="hidden sm:flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="rounded-[1.75rem] border border-[#c9ae6d]/55 bg-[#f3ecd8] px-5 py-4 shadow-[0_20px_60px_rgba(46,58,62,0.18)]">
              <p className="text-[11px] uppercase tracking-[0.35em] text-[#936718]">Field Brief</p>
              <h1 className="mt-2 font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold text-[#1f2a2f] sm:text-3xl">
                {snapshot?.game.name ?? 'Loading game'}
              </h1>
              <p className="mt-1 text-sm text-[#44545c]">
                {snapshot?.player?.displayName ?? 'Checking session'}
                {team ? ' · ' + team.name : ''}
                {currentZone ? ' · ' + currentZone.name : ''}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatusCard label="Controlled" value={String(controlledZoneCount)} />
              <StatusCard label="Deck" value={String(challengeCounts.available)} />
              <StatusCard label="Version" value={String(snapshot?.game.stateVersion ?? 0)} />
            </div>
          </div>

        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-4 sm:px-6 lg:px-8">
        <div className="pointer-events-auto mx-auto flex max-w-7xl flex-col gap-3">
          {missingToken ? (
            <Banner title="Mapbox token required" body="Add VITE_MAPBOX_ACCESS_TOKEN to the root .env file, then restart the client." tone="warning" />
          ) : null}

          {status === 'loading' ? (
            <Banner title="Loading map state" body="Fetching the authoritative snapshot from /game/:id/map-state." />
          ) : null}

          {status === 'error' ? (
            <Banner title="Unable to load map state" body={errorMessage ?? 'The snapshot request failed.'} tone="danger" />
          ) : null}

          {status === 'ready' && connectionStatus !== 'idle' && connectionStatus !== 'live' ? (
            <Banner
              title={getConnectionBannerTitle(connectionStatus)}
              body={connectionMessage ?? 'The live feed is reconnecting.'}
              tone={connectionStatus === 'error' ? 'danger' : connectionStatus === 'reconnecting' ? 'warning' : 'default'}
            />
          ) : null}

          {/* Mobile: pill toggle button when deck is closed */}
          {snapshot && !isDeckOpen ? (
            <div className="sm:hidden flex justify-end">
              <button
                className="rounded-full border border-[#c9ae6d]/55 bg-[#f3ecd8]/96 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a] shadow-[0_8px_24px_rgba(46,58,62,0.18)] backdrop-blur-sm transition hover:bg-[#eee3cb]"
                onClick={() => startTransition(() => setIsDeckOpen(true))}
                type="button"
              >
                ☰ Field Deck
              </button>
            </div>
          ) : null}

          {/* Mobile: open deck — swipeable, bare cards only */}
          {snapshot && isDeckOpen ? (
            <div
              className="sm:hidden [touch-action:none]"
              style={{
                transform: `translateY(${deckDragY}px)`,
                transition: isDraggingDeck ? 'none' : 'transform 0.4s cubic-bezier(0.22, 1, 0.36, 1)',
              }}
              onPointerDown={handleDeckPointerDown}
              onPointerMove={handleDeckPointerMove}
              onPointerUp={(e) => handleDeckPointerUp(e, showMobileCompleted, completedCards.length > 0)}
              onPointerCancel={handleDeckPointerCancel}
            >
              {/* Drag handle */}
              <div className="flex justify-center pb-3 pt-1">
                <div className="h-1 w-10 rounded-full bg-[#c8b48a]/70" />
              </div>

              <ChallengeDeck
                challenges={snapshot.challenges}
                completedCards={completedCards}
                currentZoneName={currentZone?.name ?? null}
                isActionPending={isPending}
                locationMessage={locationErrorMessage}
                locationStatus={locationStatus}
                onCaptureChallenge={handleCaptureChallenge}
                onSelectChallenge={setSelectedChallengeId}
                selectedChallengeId={selectedChallengeId}
              />

              {/* Completed row — expands upward from below after swipe-up */}
              {completedCards.length > 0 ? (
                <div
                  className="overflow-hidden transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
                  style={showMobileCompleted ? { maxHeight: '14rem', opacity: 1 } : { maxHeight: 0, opacity: 0 }}
                >
                  <div className="mt-3 -mx-1 overflow-x-auto [scrollbar-width:none] [touch-action:pan-x] [&::-webkit-scrollbar]:hidden">
                    <div className="flex w-max gap-3 px-1 pb-1 pr-5">
                      {completedCards.map(({ challenge, teamName }) => (
                        <article
                          key={challenge.id}
                          className="min-w-[12rem] max-w-[12rem] flex-none rounded-[1.2rem] border border-[#c8b48a]/45 bg-[#f7efdc] p-4 text-[#24343a] shadow-[0_10px_24px_rgba(24,32,36,0.08)]"
                        >
                          <p className="truncate text-[10px] uppercase tracking-[0.18em] text-[#7a6a48]">
                            {teamName ?? 'Unknown team'}
                          </p>
                          <h3 className="mt-1.5 line-clamp-2 font-[Georgia,Times_New_Roman,serif] text-base font-semibold text-[#24343a]">
                            {challenge.title}
                          </h3>
                          <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-[#55646b]">
                            {(challenge.config?.['short_description'] as string | undefined) ?? challenge.description}
                          </p>
                        </article>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Desktop: full section with chrome */}
          {snapshot ? (
            <section className="hidden sm:block rounded-[1.9rem] border border-[#c9ae6d]/55 bg-[#f3ecd8]/96 p-4 shadow-[0_22px_60px_rgba(46,58,62,0.18)] backdrop-blur-sm sm:p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.3em] text-[#936718]">Field Deck</p>
                  <p className="mt-2 text-sm leading-6 text-[#44545c]">
                    {challengeCounts.available} ready · {challengeCounts.completed} complete
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#f2ead6]"
                    onClick={() => startTransition(() => setIsDeckOpen((value) => !value))}
                    type="button"
                  >
                    {isDeckOpen ? 'Hide Deck' : 'Show Deck'}
                  </button>
                  <button
                    className="rounded-2xl border border-[#29414b] bg-[#24343a] px-4 py-3 text-sm font-medium text-[#f4ead7] transition hover:bg-[#1d2b30]"
                    onClick={onLeaveMap}
                    type="button"
                  >
                    Back to Lobby
                  </button>
                </div>
              </div>

              <div
                className={[
                  'grid transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
                  isDeckOpen
                    ? 'mt-4 translate-y-0 opacity-100'
                    : 'pointer-events-none mt-0 max-h-0 translate-y-8 overflow-hidden opacity-0',
                ].join(' ')}
              >
                <ChallengeDeck
                  challenges={snapshot.challenges}
                  completedCards={completedCards}
                  currentZoneName={currentZone?.name ?? null}
                  isActionPending={isPending}
                  locationMessage={locationErrorMessage}
                  locationStatus={locationStatus}
                  onCaptureChallenge={handleCaptureChallenge}
                  onSelectChallenge={setSelectedChallengeId}
                  selectedChallengeId={selectedChallengeId}
                />
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {/* Mobile menu overlay */}
      {isMenuOpen ? (
        <div
          className="sm:hidden fixed inset-0 z-50 flex items-end bg-[#162126]/40"
          onClick={() => setIsMenuOpen(false)}
        >
          <div
            className="w-full rounded-t-[1.9rem] border-t border-[#c9ae6d]/55 bg-[#f3ecd8] px-6 pb-10 pt-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-5 flex items-center justify-between">
              <p className="text-[11px] uppercase tracking-[0.3em] text-[#936718]">
                {snapshot?.game.name ?? 'Game'}
              </p>
              <button
                className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#24343a]"
                onClick={() => setIsMenuOpen(false)}
                type="button"
              >
                ✕
              </button>
            </div>
            <p className="mb-5 text-sm text-[#44545c]">
              {snapshot?.player?.displayName ?? ''}
              {team ? ' · ' + team.name : ''}
            </p>
            <button
              className="w-full rounded-2xl border border-[#29414b] bg-[#24343a] px-4 py-4 text-sm font-semibold text-[#f4ead7] transition hover:bg-[#1d2b30]"
              onClick={onLeaveMap}
              type="button"
            >
              Back to Lobby
            </button>
          </div>
        </div>
      ) : null}

      {toast ? <Toast tone={toast.tone} title={toast.title} body={toast.body} /> : null}
    </main>
  );

  function applyCompletedMutation(targetGameId: string, response: CompleteChallengeResponse): void {
    applyRealtimePayload(targetGameId, socketServerEventTypes.challengeCompleted, {
      gameId: targetGameId,
      stateVersion: response.stateVersion,
      serverTime: new Date().toISOString(),
      challenge: response.challenge,
      claim: response.claim,
      zone: response.zone,
      resourcesAwarded: response.resourcesAwarded,
    });
  }
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1.4rem] border border-[#c9ae6d]/55 bg-[#f3ecd8] px-4 py-3 text-right shadow-[0_20px_60px_rgba(46,58,62,0.18)]">
      <p className="text-[11px] uppercase tracking-[0.28em] text-[#7a5e2d]">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-[#1f2a2f]">{value}</p>
    </div>
  );
}

function Banner({
  title,
  body,
  tone = 'default',
}: {
  title: string;
  body: string;
  tone?: 'default' | 'warning' | 'danger';
}) {
  const toneClassName = tone === 'danger'
    ? 'border-[#bb4d4d]/35 bg-[#f7d9d4] text-[#6c2626]'
    : tone === 'warning'
      ? 'border-[#c69b34]/35 bg-[#faedc7] text-[#7b5a13]'
      : 'border-[#6e8e95]/35 bg-[#e1edf0] text-[#29414b]';

  return (
    <div className={'rounded-2xl border px-4 py-3 ' + toneClassName}>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-sm text-current/85">{body}</p>
    </div>
  );
}

function Toast({ tone, title, body }: ToastMessage) {
  const toneClassName = tone === 'error'
    ? 'border-[#bb4d4d]/40 bg-[#f7d9d4] text-[#6c2626]'
    : 'border-[#7b9a73]/40 bg-[#dfeadb] text-[#254028]';

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center px-4">
      <div className={'min-w-[18rem] max-w-md rounded-2xl border px-4 py-3 shadow-[0_20px_50px_rgba(24,32,36,0.22)] ' + toneClassName}>
        <p className="text-sm font-semibold">{title}</p>
        {body ? <p className="mt-1 text-sm text-current/85">{body}</p> : null}
      </div>
    </div>
  );
}

function getGameViewError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.statusCode === 401) {
      return 'Authentication required. Register and join a team before opening the game view.';
    }

    return error.message;
  }

  return 'Failed to load the game snapshot.';
}

function getBoundsFromSnapshot(snapshot: GameStateSnapshot): mapboxgl.LngLatBoundsLike | null {
  const positions = snapshot.zones.flatMap((zone) => collectGeometryPositions(zone.geometry));

  if (!positions.length) {
    return null;
  }

  const bounds = new mapboxgl.LngLatBounds(positions[0], positions[0]);
  for (const position of positions.slice(1)) {
    bounds.extend(position);
  }

  return bounds;
}

function buildChallengeCounts(snapshot: GameStateSnapshot | null) {
  return (snapshot?.challenges ?? []).reduce(
    (counts, challenge) => {
      counts[challenge.status] += 1;
      return counts;
    },
    { available: 0, claimed: 0, completed: 0 },
  );
}

function buildControlledZoneCount(snapshot: GameStateSnapshot | null, teamId: string | null): number {
  if (!snapshot || !teamId) {
    return 0;
  }

  return snapshot.zones.filter((zone) => zone.ownerTeamId === teamId).length;
}

function buildCompletedCards(snapshot: GameStateSnapshot | null): Array<{ challenge: GameStateSnapshot['challenges'][number]; teamName: string | null }> {
  if (!snapshot) {
    return [];
  }

  const completedClaimsByChallengeId = new Map<string, ChallengeClaim>();
  for (const claim of snapshot.claims) {
    if (claim.status !== 'completed') {
      continue;
    }

    const previous = completedClaimsByChallengeId.get(claim.challengeId);
    const previousTime = previous?.completedAt ? new Date(previous.completedAt).getTime() : 0;
    const nextTime = claim.completedAt ? new Date(claim.completedAt).getTime() : 0;

    if (!previous || nextTime >= previousTime) {
      completedClaimsByChallengeId.set(claim.challengeId, claim);
    }
  }

  const teamNameById = new Map(snapshot.teams.map((team) => [team.id, team.name]));

  return snapshot.challenges
    .filter((challenge) => challenge.status === 'completed')
    .sort((left, right) => left.title.localeCompare(right.title))
    .map((challenge) => {
      const completedClaim = completedClaimsByChallengeId.get(challenge.id);
      return {
        challenge,
        teamName: completedClaim ? teamNameById.get(completedClaim.teamId) ?? null : null,
      };
    });
}

function createCurrentLocationMarkerElement(): HTMLDivElement {
  const element = document.createElement('div');
  element.style.width = '18px';
  element.style.height = '18px';
  element.style.borderRadius = '9999px';
  element.style.border = '3px solid #f3ecd8';
  element.style.background = '#1f4c63';
  element.style.boxShadow = '0 0 0 6px rgba(31, 76, 99, 0.18), 0 10px 22px rgba(14, 24, 29, 0.2)';
  return element;
}
function pruneRealtimeKeys(appliedKeys: Map<number, Set<string>>, currentVersion: number): void {
  for (const version of appliedKeys.keys()) {
    if (version < currentVersion) {
      appliedKeys.delete(version);
    }
  }
}

function getConnectionBannerTitle(status: RealtimeConnectionStatus): string {
  switch (status) {
    case 'connecting':
      return 'Connecting live feed';
    case 'reconnecting':
      return 'Reconnecting live feed';
    case 'error':
      return 'Live feed offline';
    default:
      return 'Live feed status';
  }
}

function isJoinAckSuccess(response: unknown): response is { ok: true } {
  return typeof response === 'object' && response !== null && 'ok' in response && (response as { ok: unknown }).ok === true;
}

function getJoinAckErrorMessage(response: unknown): string {
  if (typeof response === 'object' && response !== null && 'error' in response) {
    const error = (response as { error?: { message?: unknown } }).error;
    if (typeof error?.message === 'string') {
      return error.message;
    }
  }

  return 'Failed to join the live game feed.';
}

function formatSocketReason(reason: string): string {
  switch (reason) {
    case 'transport close':
      return 'transport closed';
    case 'transport error':
      return 'transport error';
    case 'ping timeout':
      return 'ping timeout';
    default:
      return reason;
  }
}

function getRealtimeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Failed to refresh live state.';
}

function getMutationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Request failed.';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
