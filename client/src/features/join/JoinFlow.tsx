import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { socketServerEventTypes, type Game, type MapDefinition, type MapZone, type Player, type SocketEventPayloadMap, type Team, type Zone } from '@city-game/shared';
import {
  ApiError,
  getActiveGame,
  getCurrentPlayer,
  getGame,
  getMap,
  getTeams,
  joinTeam,
  leaveCurrentTeam,
  listMapZones,
  listPlayers,
  listZones,
  registerPlayer,
  setCurrentPlayerReady,
  startLobbyGame,
  subscribeCurrentPlayerPush,
} from '../../lib/api';
import { buildRenderedZoneGeometry, collectGeometryPositions } from '../game/mapGeometry';
import {
  getNotificationPermission,
  subscribeToPushNotifications,
  supportsPushNotifications,
} from '../../lib/push-notifications';
import { createRealtimeSocket, joinRealtimeGame, leaveRealtimeGame } from '../../lib/realtime';
import { useJoinFlowStore } from '../../store/joinFlowStore';
import { CountdownOverlay } from './CountdownOverlay';
import { LobbyScreen } from './LobbyScreen';
import { TeamPicker } from './TeamPicker';

interface JoinFlowProps {
  initialGameId: string | null;
  onEnterGame(gameId: string): void;
  suppressAutoEnter: boolean;
}

type LoadStatus = 'loading' | 'ready' | 'empty' | 'error';
type PushPromptState = 'hidden' | 'ready' | 'subscribing' | 'enabled';

const mapboxToken = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? import.meta.env.MAPBOX_ACCESS_TOKEN ?? '').trim();

export function JoinFlow({ initialGameId, onEnterGame, suppressAutoEnter }: JoinFlowProps) {
  const persistedStep = useJoinFlowStore((state) => state.step);
  const persistedDisplayName = useJoinFlowStore((state) => state.displayName);
  const setSession = useJoinFlowStore((state) => state.setSession);

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [mapDefinition, setMapDefinition] = useState<MapDefinition | null>(null);
  const [mapZones, setMapZones] = useState<MapZone[]>([]);
  const [spectatorZones, setSpectatorZones] = useState<Zone[]>([]);
  const [name, setName] = useState(persistedDisplayName);
  const [submitting, setSubmitting] = useState<'register' | null>(null);
  const [joiningTeamId, setJoiningTeamId] = useState<string | null>(null);
  const [isLeavingTeam, setIsLeavingTeam] = useState(false);
  const [readyPending, setReadyPending] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [step, setStep] = useState(persistedStep);
  const [countdownActive, setCountdownActive] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [pushPromptState, setPushPromptState] = useState<PushPromptState>('hidden');
  const [pushPromptMessage, setPushPromptMessage] = useState<string | null>(null);
  const countdownStartedRef = useRef(false);

  const loadRoster = useCallback(async (gameId: string, signal?: AbortSignal) => {
    const [nextTeams, nextPlayers] = await Promise.all([
      getTeams(gameId, signal),
      listPlayers(gameId, signal),
    ]);
    setTeams(nextTeams);
    setPlayers(nextPlayers);
    return { nextTeams, nextPlayers };
  }, []);

  const loadMapAssets = useCallback(async (mapId: string | null, signal?: AbortSignal) => {
    if (!mapId) {
      setMapDefinition(null);
      setMapZones([]);
      return;
    }

    const [nextMap, nextZones] = await Promise.all([
      getMap(mapId, signal),
      listMapZones(mapId, signal),
    ]);

    setMapDefinition(nextMap);
    setMapZones(nextZones);
  }, []);

  const loadSpectatorAssets = useCallback(async (gameId: string, signal?: AbortSignal) => {
    const [nextTeams, nextZones] = await Promise.all([
      getTeams(gameId, signal),
      listZones(gameId, signal),
    ]);

    setTeams(nextTeams);
    setSpectatorZones(nextZones);
  }, []);

  const hydrate = useCallback(async (signal?: AbortSignal) => {
    setStatus('loading');
    setMessage(null);

    try {
      const resolvedGame = initialGameId
        ? await getGame(initialGameId, signal)
        : await getActiveGame(signal);

      setGame(resolvedGame);
      setSession({ gameId: resolvedGame.id });

      let currentPlayer: Player | null = null;
      try {
        currentPlayer = await getCurrentPlayer(signal);
      } catch (error) {
        if (!(error instanceof ApiError) || error.statusCode !== 401) {
          throw error;
        }
      }

      if (currentPlayer && currentPlayer.gameId !== resolvedGame.id) {
        setPlayer(null);
        setStatus('ready');
        setStep('home');
        setMessage('Current session belongs to a different game. Open a private window to join this one.');
        return;
      }

      setPlayer(currentPlayer);
      if (currentPlayer) {
        setName(currentPlayer.displayName);
        setSession({
          displayName: currentPlayer.displayName,
          playerId: currentPlayer.id,
          teamId: currentPlayer.teamId,
        });
      }

      if (resolvedGame.status === 'active' && currentPlayer?.teamId && !suppressAutoEnter) {
        onEnterGame(resolvedGame.id);
        return;
      }

      if (resolvedGame.status !== 'setup') {
        await loadSpectatorAssets(resolvedGame.id, signal);
        setStatus('ready');
        setStep('home');
        if (resolvedGame.status === 'active' && currentPlayer?.teamId) {
          setMessage('Game in progress. Return to the live map when you are ready.');
        } else if (resolvedGame.status === 'active') {
          setMessage('Spectating the live game.');
        } else {
          setMessage('Game finished. Spectator map remains available.');
        }
        return;
      }

      await loadRoster(resolvedGame.id, signal);

      if (currentPlayer?.teamId) {
        await loadMapAssets(resolvedGame.mapId, signal);
        setStep('lobby');
        setSession({
          step: 'lobby',
          gameId: resolvedGame.id,
          playerId: currentPlayer.id,
          teamId: currentPlayer.teamId,
          displayName: currentPlayer.displayName,
        });
      } else if (currentPlayer) {
        setStep('team_picker');
        setSession({
          step: 'team_picker',
          gameId: resolvedGame.id,
          playerId: currentPlayer.id,
          teamId: null,
          displayName: currentPlayer.displayName,
        });
      } else {
        setStep('home');
        setSession({
          step: 'home',
          gameId: resolvedGame.id,
          playerId: null,
          teamId: null,
        });
      }

      setStatus('ready');
    } catch (error) {
      if (signal?.aborted) {
        return;
      }

      if (error instanceof ApiError && error.statusCode === 404) {
        setStatus('empty');
        setGame(null);
        setPlayer(null);
        setTeams([]);
        setPlayers([]);
        setMapDefinition(null);
        setMapZones([]);
        setSpectatorZones([]);
        setStep('home');
        setMessage('No active game is running right now.');
        return;
      }

      setStatus('error');
      setMessage(getErrorMessage(error, 'Failed to load the current game.'));
    }
  }, [initialGameId, loadMapAssets, loadRoster, loadSpectatorAssets, onEnterGame, setSession, suppressAutoEnter]);

  useEffect(() => {
    const controller = new AbortController();
    void hydrate(controller.signal);
    return () => controller.abort();
  }, [hydrate]);

  useEffect(() => {
    if (!(status === 'empty' || (status === 'ready' && game && game.status !== 'setup'))) {
      return;
    }

    const interval = window.setInterval(() => {
      void hydrate();
    }, 10000);

    return () => window.clearInterval(interval);
  }, [game?.status, hydrate, status]);

  useEffect(() => {
    if (status !== 'ready' || step !== 'team_picker' || !game) {
      return;
    }

    const interval = window.setInterval(() => {
      void loadRoster(game.id).catch(() => undefined);
    }, 5000);

    return () => window.clearInterval(interval);
  }, [game, loadRoster, status, step]);

  useEffect(() => {
    if (status !== 'ready' || step !== 'lobby' || !game || !player?.teamId) {
      setPushPromptState('hidden');
      setPushPromptMessage(null);
      return;
    }

    if (!supportsPushNotifications()) {
      setPushPromptState('hidden');
      setPushPromptMessage(null);
      return;
    }

    if (player.pushSubscription) {
      clearPushPromptDismissed(game.id, player.id);
      setPushPromptState('enabled');
      setPushPromptMessage(null);
      return;
    }

    if (getNotificationPermission() === 'denied' || isPushPromptDismissed(game.id, player.id)) {
      setPushPromptState('hidden');
      setPushPromptMessage(null);
      return;
    }

    setPushPromptState((currentState) => currentState === 'subscribing' ? currentState : 'ready');
  }, [game, player?.id, player?.pushSubscription, player?.teamId, status, step]);

  useEffect(() => {
    if (status !== 'ready' || step !== 'lobby' || !game || !player?.teamId) {
      return;
    }

    const socket = createRealtimeSocket();
    setConnectionMessage('Connecting lobby.');

    socket.on('connect', () => {
      setConnectionMessage('Syncing lobby.');
      joinRealtimeGame(socket, game.id, undefined, (response) => {
        if (!isJoinAckSuccess(response)) {
          setConnectionMessage(getJoinAckErrorMessage(response));
          return;
        }

        setConnectionMessage(null);
      });
    });

    socket.on('disconnect', () => {
      setConnectionMessage('Lobby disconnected. Reconnecting…');
    });

    socket.on(socketServerEventTypes.playerJoined, (payload: SocketEventPayloadMap['player_joined']) => {
      if (payload.gameId !== game.id) {
        return;
      }

      setPlayers((currentPlayers) => upsertPlayer(currentPlayers, payload.player));
      if (payload.player.id === player.id) {
        setPlayer(payload.player);
      }
      const joinedTeam = payload.team;
      if (joinedTeam) {
        setTeams((currentTeams) => upsertTeam(currentTeams, joinedTeam));
      }
    });

    socket.on(socketServerEventTypes.gameStarted, (payload: SocketEventPayloadMap['game_started']) => {
      if (payload.gameId !== game.id || countdownStartedRef.current) {
        return;
      }

      countdownStartedRef.current = true;
      setGame(payload.game);
      setCountdownActive(true);
      setStep('countdown');
      setSession({ step: 'countdown' });
    });

    socket.connect();

    return () => {
      countdownStartedRef.current = false;
      setConnectionMessage(null);
      if (socket.connected) {
        leaveRealtimeGame(socket, game.id);
      }
      socket.disconnect();
    };
  }, [game, player?.teamId, setSession, status, step]);



  async function handleRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!game || name.trim().length < 2) {
      return;
    }

    setSubmitting('register');
    setMessage(null);

    try {
      const nextPlayer = await registerPlayer(game.id, name.trim());
      setPlayer(nextPlayer);
      setSession({
        step: 'team_picker',
        gameId: game.id,
        playerId: nextPlayer.id,
        teamId: null,
        displayName: nextPlayer.displayName,
      });
      await loadRoster(game.id);
      setStep('team_picker');
    } catch (error) {
      setMessage(getErrorMessage(error, 'Unable to register right now.'));
    } finally {
      setSubmitting(null);
    }
  }

  async function handleJoinTeam(team: Team) {
    if (!game || !player) {
      return;
    }

    setJoiningTeamId(team.id);
    setMessage(null);

    try {
      const result = await joinTeam(game.id, team.joinCode);
      const nextPlayer = result.player;
      setPlayer(nextPlayer);
      setPlayers((currentPlayers) => upsertPlayer(currentPlayers, nextPlayer));
      setTeams((currentTeams) => upsertTeam(currentTeams, result.team));
      await loadMapAssets(game.mapId);
      setStep('lobby');
      setSession({
        step: 'lobby',
        gameId: game.id,
        playerId: nextPlayer.id,
        teamId: nextPlayer.teamId,
        displayName: nextPlayer.displayName,
      });
    } catch (error) {
      setMessage(getErrorMessage(error, 'Unable to join that team.'));
    } finally {
      setJoiningTeamId(null);
    }
  }

  async function handleLeaveTeam() {
    if (!game || !player || isLeavingTeam) {
      return;
    }

    setIsLeavingTeam(true);
    setMessage(null);

    try {
      const nextPlayer = await leaveCurrentTeam();
      setPlayer(nextPlayer);
      setPlayers((currentPlayers) => upsertPlayer(currentPlayers, nextPlayer));
      setStep('team_picker');
      setSession({
        step: 'team_picker',
        gameId: game.id,
        playerId: nextPlayer.id,
        teamId: null,
        displayName: nextPlayer.displayName,
      });
    } catch (error) {
      setMessage(getErrorMessage(error, 'Unable to leave the team right now.'));
    } finally {
      setIsLeavingTeam(false);
    }
  }

  async function handleSetReady(ready: boolean) {
    if (!player || readyPending) {
      return;
    }

    setReadyPending(true);
    setMessage(null);

    try {
      const nextPlayer = await setCurrentPlayerReady(ready);
      setPlayer(nextPlayer);
      setPlayers((currentPlayers) => upsertPlayer(currentPlayers, nextPlayer));
    } catch (error) {
      setMessage(getErrorMessage(error, ready ? 'Unable to mark ready right now.' : 'Unable to mark not ready right now.'));
    } finally {
      setReadyPending(false);
    }
  }

  async function handleStartGame() {
    if (!game || !player || startPending) {
      return;
    }

    setStartPending(true);
    setMessage(null);

    try {
      const updatedGame = await startLobbyGame();
      countdownStartedRef.current = true;
      setGame(updatedGame);
      setCountdownActive(true);
      setStep('countdown');
      setSession({ step: 'countdown' });
    } catch (error) {
      setMessage(getErrorMessage(error, 'Unable to start the game right now.'));
    } finally {
      setStartPending(false);
    }
  }

  async function handleEnableNotifications() {
    if (!game || !player || pushPromptState === 'subscribing') {
      return;
    }

    setPushPromptState('subscribing');
    setPushPromptMessage(null);

    try {
      const subscription = await subscribeToPushNotifications();
      const nextPlayer = await subscribeCurrentPlayerPush(subscription);
      setPlayer(nextPlayer);
      setPlayers((currentPlayers) => upsertPlayer(currentPlayers, nextPlayer));
      clearPushPromptDismissed(game.id, nextPlayer.id);
      setPushPromptState('enabled');
    } catch (error) {
      if (getNotificationPermission() === 'denied') {
        dismissPushPrompt(game.id, player.id);
        setPushPromptState('hidden');
        setPushPromptMessage(null);
        return;
      }

      setPushPromptState('ready');
      setPushPromptMessage(getErrorMessage(error, 'Unable to enable notifications right now.'));
    }
  }

  function handleDismissNotifications() {
    if (!game || !player) {
      return;
    }

    dismissPushPrompt(game.id, player.id);
    setPushPromptState('hidden');
    setPushPromptMessage(null);
  }

  function handleBackToHome() {
    setStep('home');
    setSession({ step: 'home' });
  }

  function handleContinueToTeams() {
    setStep('team_picker');
    setSession({ step: 'team_picker' });
  }

  function handleCountdownComplete() {
    if (!game) {
      return;
    }

    setCountdownActive(false);
    onEnterGame(game.id);
  }

  const canReturnToGame = Boolean(game && game.status === 'active' && player?.teamId);
  const canJoinCurrentGame = Boolean(game && game.status === 'setup');
  const teamedPlayers = useMemo(() => players.filter((entry) => entry.teamId), [players]);
  const readyPlayers = useMemo(() => teamedPlayers.filter((entry) => isLobbyReady(entry.metadata)).length, [teamedPlayers]);
  const isCurrentPlayerReady = useMemo(() => (player ? isLobbyReady(player.metadata) : false), [player]);
  const canStartLobbyGame = Boolean(teamedPlayers.length > 0 && readyPlayers === teamedPlayers.length);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#f5f0e8] text-[#223238]">
      {status === 'loading' ? <LoadingScreen /> : null}

      {status === 'empty' ? <EmptyState message={message ?? 'No active game is running right now.'} /> : null}

      {status === 'error' ? <ErrorState message={message ?? 'Unable to load the current game.'} /> : null}

      {status === 'ready' && game && step === 'home' ? (
        <HomeScreen
          canJoinCurrentGame={canJoinCurrentGame}
          canReturnToGame={canReturnToGame}
          game={game}
          message={message}
          spectatorTeams={teams}
          spectatorZones={spectatorZones}
          name={name}
          onEnterGame={() => onEnterGame(game.id)}
          onContinue={handleContinueToTeams}
          onNameChange={setName}
          onRegister={handleRegister}
          player={player}
          submitting={submitting === 'register'}
        />
      ) : null}

      {status === 'ready' && game && player && step === 'team_picker' ? (
        <main className="min-h-screen bg-[#f5f0e8]">
          <TeamPicker
            teams={teams}
            players={players}
            joiningTeamId={joiningTeamId}
            onBack={handleBackToHome}
            onJoin={handleJoinTeam}
          />
          {message ? <FloatingMessage message={message} /> : null}
        </main>
      ) : null}

      {status === 'ready' && game && player && (step === 'lobby' || step === 'countdown') ? (
        <>
          <LobbyScreen
            connectionMessage={connectionMessage}
            game={game}
            mapDefinition={mapDefinition}
            mapZones={mapZones}
            player={player}
            players={players}
            teams={teams}
            onLeaveTeam={handleLeaveTeam}
            isLeavingTeam={isLeavingTeam}
            canShowNotificationPrompt={pushPromptState === 'ready' || pushPromptState === 'subscribing'}
            notificationPromptMessage={pushPromptMessage}
            notificationPromptPending={pushPromptState === 'subscribing'}
            onEnableNotifications={handleEnableNotifications}
            onDismissNotifications={handleDismissNotifications}
            isCurrentPlayerReady={isCurrentPlayerReady}
            readyCount={readyPlayers}
            readyPending={readyPending}
            startPending={startPending}
            totalReadyEligiblePlayers={teamedPlayers.length}
            canStartGame={canStartLobbyGame}
            onSetReady={handleSetReady}
            onStartGame={handleStartGame}
          />
          <CountdownOverlay active={countdownActive} onComplete={handleCountdownComplete} />
        </>
      ) : null}
    </div>
  );
}

function HomeScreen(props: {
  game: Game;
  player: Player | null;
  name: string;
  message: string | null;
  spectatorTeams: Team[];
  spectatorZones: Zone[];
  submitting: boolean;
  canJoinCurrentGame: boolean;
  canReturnToGame: boolean;
  onContinue(): void;
  onNameChange(value: string): void;
  onRegister(event: FormEvent<HTMLFormElement>): void;
  onEnterGame(): void;
}) {
  const subtitle = props.game.city ? props.game.city : null;
  const hasRegisteredPlayer = Boolean(props.player && props.player.gameId === props.game.id);
  const showSpectatorView = !props.canJoinCurrentGame;

  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-[#f5f0e8] px-5 py-8 sm:px-8">
      {showSpectatorView ? <SpectatorMapBackground game={props.game} teams={props.spectatorTeams} zones={props.spectatorZones} /> : null}
      {showSpectatorView ? <div className="absolute inset-0 bg-[rgba(245,240,232,0.5)]" /> : null}
      <div className="relative z-10 mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-3xl flex-col justify-between">
        <div>
          <p className="text-center font-['IBM_Plex_Mono',monospace] text-[11px] uppercase tracking-[0.38em] text-[#8c7a57]">
            TERRITORY
          </p>
        </div>

        <section className="flex flex-1 flex-col items-center justify-center text-center">
          <h1 className="font-[Georgia,Times_New_Roman,serif] text-5xl font-semibold text-[#223238] sm:text-6xl">
            {props.game.name}
          </h1>
          {subtitle ? (
            <p className="mt-4 font-[Georgia,Times_New_Roman,serif] text-lg text-[#6d6758] sm:text-xl">{subtitle}</p>
          ) : null}

          {props.canJoinCurrentGame ? (
            hasRegisteredPlayer ? (
              <div className="mt-10 w-full max-w-sm rounded-[1.8rem] border border-[#d5c59f] bg-[#f0ebe0] px-6 py-6 shadow-[0_20px_48px_rgba(35,52,58,0.12)]">
                <p className="text-[11px] uppercase tracking-[0.3em] text-[#8c7a57]">Session Ready</p>
                <p className="mt-4 font-[Georgia,Times_New_Roman,serif] text-3xl font-semibold text-[#223238]">
                  {props.player?.displayName}
                </p>
                <p className="mt-3 text-sm leading-6 text-[#5a676c]">
                  This browser already has a registered player in the current game.
                </p>
                <button
                  className="mt-6 inline-flex w-full items-center justify-center rounded-[1.25rem] bg-[#c8a86b] px-4 py-3 font-[Georgia,Times_New_Roman,serif] text-lg text-[#1f2a2f] transition hover:bg-[#d3b57c]"
                  onClick={props.onContinue}
                  type="button"
                >
                  Continue
                </button>
              </div>
            ) : (
              <form className="mt-10 w-full max-w-sm" onSubmit={props.onRegister}>
                <input
                  className="w-full rounded-[1.45rem] border border-[#d5c59f] bg-[#fffaf0] px-5 py-4 text-center text-xl text-[#223238] outline-none transition placeholder:text-[#8a8476] focus:border-[#c8a86b] focus:bg-[#fffdf8]"
                  maxLength={100}
                  onChange={(event) => props.onNameChange(event.target.value)}
                  placeholder="Your name"
                  value={props.name}
                />
                <button
                  className="mt-4 inline-flex w-full items-center justify-center rounded-[1.45rem] bg-[#c8a86b] px-4 py-4 font-[Georgia,Times_New_Roman,serif] text-xl text-[#1f2a2f] transition hover:bg-[#d3b57c] disabled:cursor-not-allowed disabled:bg-[#d8ceb9] disabled:text-[#867c69]"
                  disabled={props.submitting || props.name.trim().length < 2}
                  type="submit"
                >
                  {props.submitting ? 'Joining…' : 'Join Game →'}
                </button>
              </form>
            )
          ) : (
            <div className="mt-10 w-full max-w-2xl rounded-[1.8rem] border border-[#d7c7a3] bg-[#f0ebe0]/94 px-6 py-6 text-center shadow-[0_20px_48px_rgba(35,52,58,0.12)] backdrop-blur">
              <p className="text-[11px] uppercase tracking-[0.3em] text-[#8c7a57]">Spectator View</p>
              <p className="mt-3 text-base text-[#5b666a]">Map view only. Joining is closed for this game.</p>
              {props.canReturnToGame ? (
                <button
                  className="mt-5 inline-flex items-center justify-center rounded-[1.2rem] bg-[#c8a86b] px-5 py-3 font-[Georgia,Times_New_Roman,serif] text-lg text-[#1f2a2f] transition hover:bg-[#d3b57c]"
                  onClick={props.onEnterGame}
                  type="button"
                >
                  Return to Game
                </button>
              ) : null}
            </div>
          )}

          {props.message ? <p className="mt-5 max-w-lg text-sm leading-6 text-[#6d6758]">{props.message}</p> : null}
        </section>
      </div>
    </main>
  );
}

function LoadingScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f0e8] px-6 text-center text-[#5a676c]">
      <div>
        <p className="font-['IBM_Plex_Mono',monospace] text-[11px] uppercase tracking-[0.36em] text-[#8c7a57]">Territory</p>
        <p className="mt-4 font-[Georgia,Times_New_Roman,serif] text-2xl text-[#223238]">Loading current game…</p>
      </div>
    </main>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f0e8] px-6 text-center">
      <div>
        <p className="font-[Georgia,Times_New_Roman,serif] text-3xl text-[#223238]">No active game</p>
        <p className="mt-4 text-[#6d6758]">{message}</p>
      </div>
    </main>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f0e8] px-6 text-center">
      <div>
        <p className="font-[Georgia,Times_New_Roman,serif] text-3xl text-[#223238]">Unable to load the game</p>
        <p className="mt-4 text-[#6d6758]">{message}</p>
      </div>
    </main>
  );
}

function FloatingMessage({ message }: { message: string }) {
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-30 flex justify-center">
      <div className="max-w-md rounded-full border border-[#d5c59f] bg-[#f7efdc]/96 px-4 py-2 text-sm text-[#4f5d62] shadow-[0_16px_34px_rgba(31,42,47,0.12)] backdrop-blur">
        {message}
      </div>
    </div>
  );
}

function upsertPlayer(players: Player[], player: Player) {
  const existingIndex = players.findIndex((entry) => entry.id === player.id);
  if (existingIndex === -1) {
    return [...players, player];
  }

  const nextPlayers = players.slice();
  nextPlayers[existingIndex] = player;
  return nextPlayers;
}

function upsertTeam(teams: Team[], team: Team) {
  const existingIndex = teams.findIndex((entry) => entry.id === team.id);
  if (existingIndex === -1) {
    return [...teams, team];
  }

  const nextTeams = teams.slice();
  nextTeams[existingIndex] = team;
  return nextTeams;
}

function isLobbyReady(metadata: Player['metadata'] | null | undefined) {
  return metadata?.lobby_ready === true;
}

function isJoinAckSuccess(response: unknown): response is { ok: true } {
  if (!response || typeof response !== 'object') {
    return false;
  }

  return (response as { ok?: unknown }).ok === true;
}

function getJoinAckErrorMessage(response: unknown): string {
  if (!response || typeof response !== 'object' || !('error' in response)) {
    return 'Unable to join the lobby socket.';
  }

  const error = (response as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' ? error.message : 'Unable to join the lobby socket.';
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
function getPushPromptStorageKey(gameId: string, playerId: string) {
  return `city-game:push-prompt:${gameId}:${playerId}`;
}

function isPushPromptDismissed(gameId: string, playerId: string) {
  try {
    return window.localStorage.getItem(getPushPromptStorageKey(gameId, playerId)) === 'dismissed';
  } catch {
    return false;
  }
}

function dismissPushPrompt(gameId: string, playerId: string) {
  try {
    window.localStorage.setItem(getPushPromptStorageKey(gameId, playerId), 'dismissed');
  } catch {
    // Ignore storage failures; push remains optional.
  }
}

function clearPushPromptDismissed(gameId: string, playerId: string) {
  try {
    window.localStorage.removeItem(getPushPromptStorageKey(gameId, playerId));
  } catch {
    // Ignore storage failures; push remains optional.
  }
}

function SpectatorMapBackground({ game, teams, zones }: { game: Game; teams: Team[]; zones: Zone[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const fitDoneRef = useRef(false);

  const sourceData = useMemo(() => {
    const teamColorById = new Map(teams.map((team) => [team.id, team.color]));

    return {
      type: 'FeatureCollection' as const,
      features: zones.map((zone) => ({
        type: 'Feature' as const,
        id: zone.id,
        properties: {
          id: zone.id,
          name: zone.name,
          fillColor: zone.ownerTeamId ? blendHex(teamColorById.get(zone.ownerTeamId) ?? '#c8a86b', '#c9c0af', 0.62) : '#b8b9b3',
          lineColor: zone.ownerTeamId ? blendHex(teamColorById.get(zone.ownerTeamId) ?? '#756e61', '#596166', 0.48) : '#7d817b',
          fillOpacity: zone.ownerTeamId ? 0.24 : 0.14,
          lineOpacity: zone.ownerTeamId ? 0.82 : 0.58,
        },
        geometry: buildRenderedZoneGeometry(zone),
      })),
    };
  }, [teams, zones]);

  useEffect(() => {
    if (!containerRef.current || !mapboxToken || mapRef.current) {
      return;
    }

    let disposed = false;

    void import('mapbox-gl').then((mapboxglModule) => {
      if (disposed || !containerRef.current || mapRef.current) {
        return;
      }

      const mapboxgl = mapboxglModule.default;
      mapboxgl.accessToken = mapboxToken;

      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: 'mapbox://styles/saamoz/cmng3j80c004001s831aw5e3b',
        center: [game.centerLng, game.centerLat],
        zoom: game.defaultZoom,
        attributionControl: false,
        interactive: false,
        pitchWithRotate: false,
        performanceMetricsCollection: false,
      });

      mapRef.current = map;

      map.on('load', () => {
        if (disposed) {
          return;
        }

        if (!map.getSource('spectator-zones')) {
          map.addSource('spectator-zones', {
            type: 'geojson',
            data: sourceData as any,
          });
        }

        if (!map.getLayer('spectator-zones-fill')) {
          map.addLayer({
            id: 'spectator-zones-fill',
            type: 'fill',
            source: 'spectator-zones',
            filter: ['==', '$type', 'Polygon'],
            paint: {
              'fill-color': ['coalesce', ['get', 'fillColor'], '#b8b9b3'],
              'fill-opacity': ['coalesce', ['get', 'fillOpacity'], 0.18],
            },
          });
        }

        if (!map.getLayer('spectator-zones-line')) {
          map.addLayer({
            id: 'spectator-zones-line',
            type: 'line',
            source: 'spectator-zones',
            paint: {
              'line-color': ['coalesce', ['get', 'lineColor'], '#7d817b'],
              'line-width': 2,
              'line-opacity': ['coalesce', ['get', 'lineOpacity'], 0.72],
            },
          });
        }
      });
    });

    return () => {
      disposed = true;
      fitDoneRef.current = false;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [game.centerLat, game.centerLng, game.defaultZoom, sourceData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const source = map.getSource('spectator-zones');
    if (source && 'setData' in source) {
      source.setData(sourceData);
    }
  }, [sourceData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || fitDoneRef.current || !zones.length) {
      return;
    }

    const positions = zones.flatMap((zone) => collectGeometryPositions(buildRenderedZoneGeometry(zone)));
    if (!positions.length) {
      return;
    }

    const [firstLng, firstLat] = positions[0];
    let minLng = firstLng;
    let maxLng = firstLng;
    let minLat = firstLat;
    let maxLat = firstLat;

    for (const [lng, lat] of positions) {
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }

    map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
      padding: 72,
      duration: 0,
    });
    fitDoneRef.current = true;
  }, [zones]);

  return <div ref={containerRef} className="absolute inset-0" />;
}

function blendHex(sourceColor: string, targetColor: string, targetWeight: number): string {
  const source = parseHexColor(sourceColor);
  const target = parseHexColor(targetColor);

  if (!source || !target) {
    return sourceColor;
  }

  const weight = Math.min(Math.max(targetWeight, 0), 1);
  const mix = source.map((value, index) => Math.round((value * (1 - weight)) + (target[index] * weight)));
  return '#' + mix.map((value) => value.toString(16).padStart(2, '0')).join('');
}

function parseHexColor(color: string): [number, number, number] | null {
  const normalized = color.trim().replace('#', '');
  const expanded = normalized.length === 3
    ? normalized.split('').map((part) => part + part).join('')
    : normalized;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    return null;
  }

  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}
