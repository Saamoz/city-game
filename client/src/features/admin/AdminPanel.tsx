import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  Challenge,
  ChallengeSet,
  Game,
  GameSettings,
  JsonObject,
  MapDefinition,
  Player,
  ScoreboardEntry,
  Team,
  WinCondition,
  Zone,
} from '@city-game/shared';
import {
  ApiError,
  adminAssignZoneOwner,
  adminForceCompleteChallenge,
  adminMovePlayerTeam,
  adminRebroadcastGameState,
  adminResetChallenge,
  createGameDefinition,
  createTeamDefinition,
  getGame,
  getScoreboard,
  getTeams,
  listChallengeSets,
  listGameChallenges,
  listGames,
  listMaps,
  listPlayers,
  listZones,
  transitionGameLifecycle,
  updateGameDefinition,
  updateTeamDefinition,
} from '../../lib/api';

interface AdminPanelProps {
  initialGameId: string | null;
}

type NoticeTone = 'info' | 'success' | 'error';
type PanelStatus = 'loading' | 'ready' | 'error';
type LifecycleTransition = 'start' | 'pause' | 'resume' | 'end';
type WinConditionKind = 'all_zones' | 'zone_majority' | 'time_limit';

interface NoticeState {
  tone: NoticeTone;
  message: string;
}

interface GameFormState {
  name: string;
  city: string;
  modeKey: Game['modeKey'];
  mapId: string;
  challengeSetId: string;
  winConditionType: WinConditionKind;
  zoneMajorityThreshold: string;
  timeLimitMinutes: string;
  activeChallengeCount: string;
  requireGpsAccuracy: boolean;
  broadcastTeamLocations: boolean;
}

interface TeamDraftState {
  name: string;
  color: string;
}

const INITIAL_GAME_FORM: GameFormState = {
  name: '',
  city: '',
  modeKey: 'territory',
  mapId: '',
  challengeSetId: '',
  winConditionType: 'all_zones',
  zoneMajorityThreshold: '60',
  timeLimitMinutes: '60',
  activeChallengeCount: '3',
  requireGpsAccuracy: false,
  broadcastTeamLocations: false,
};

const INITIAL_TEAM_DRAFT: TeamDraftState = {
  name: '',
  color: '#C14C33',
};

const TEAM_COLOR_SWATCHES = ['#C14C33', '#2660A4', '#D19A1F', '#2E6F57', '#7B3F8C', '#6A4E3B'];

export function AdminPanel({ initialGameId }: AdminPanelProps) {
  const [status, setStatus] = useState<PanelStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [isSavingGame, setIsSavingGame] = useState(false);
  const [isCreatingTeam, setIsCreatingTeam] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [games, setGames] = useState<Game[]>([]);
  const [maps, setMaps] = useState<MapDefinition[]>([]);
  const [challengeSets, setChallengeSets] = useState<ChallengeSet[]>([]);
  const [selectedGameId, setSelectedGameId] = useState<string | null>(initialGameId);
  const [currentGame, setCurrentGame] = useState<Game | null>(null);
  const [gameForm, setGameForm] = useState<GameFormState>(INITIAL_GAME_FORM);
  const [teams, setTeams] = useState<Team[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [scoreboard, setScoreboard] = useState<ScoreboardEntry[]>([]);
  const [teamDraft, setTeamDraft] = useState<TeamDraftState>(INITIAL_TEAM_DRAFT);
  const [teamEdits, setTeamEdits] = useState<Record<string, TeamDraftState>>({});
  const [selectedChallengeId, setSelectedChallengeId] = useState('');
  const [selectedZoneId, setSelectedZoneId] = useState('');
  const [selectedZoneOwnerTeamId, setSelectedZoneOwnerTeamId] = useState('');
  const [selectedPlayerId, setSelectedPlayerId] = useState('');
  const [selectedPlayerTeamId, setSelectedPlayerTeamId] = useState('');

  const playerCountByTeamId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const player of players) {
      if (!player.teamId) {
        continue;
      }
      counts.set(player.teamId, (counts.get(player.teamId) ?? 0) + 1);
    }
    return counts;
  }, [players]);

  const selectedMap = useMemo(() => maps.find((entry) => entry.id === gameForm.mapId) ?? null, [gameForm.mapId, maps]);
  const selectedChallengeSet = useMemo(
    () => challengeSets.find((entry) => entry.id === gameForm.challengeSetId) ?? null,
    [challengeSets, gameForm.challengeSetId],
  );
  const canEditSetupBindings = !currentGame || currentGame.status === 'setup';

  const syncRoute = useCallback((gameId: string | null) => {
    if (typeof window === 'undefined') {
      return;
    }

    const search = gameId ? '?gameId=' + encodeURIComponent(gameId) : '';
    window.history.replaceState({}, '', '/admin' + search);
  }, []);

  const hydrateTeamEdits = useCallback((nextTeams: Team[]) => {
    setTeamEdits(Object.fromEntries(nextTeams.map((team) => [team.id, { name: team.name, color: team.color }])));
  }, []);

  const loadGameBundle = useCallback(async (gameId: string) => {
    const [game, nextTeams, nextPlayers, nextZones, nextChallenges, nextScoreboard] = await Promise.all([
      getGame(gameId),
      getTeams(gameId),
      listPlayers(gameId),
      listZones(gameId),
      listGameChallenges(gameId),
      getScoreboard(gameId),
    ]);

    setCurrentGame(game);
    setGameForm(buildGameForm(game));
    setTeams(nextTeams);
    setPlayers(nextPlayers);
    setZones(nextZones);
    setChallenges(nextChallenges);
    setScoreboard(nextScoreboard);
    hydrateTeamEdits(nextTeams);
    setSelectedChallengeId((current) => nextChallenges.some((entry) => entry.id === current) ? current : (nextChallenges[0]?.id ?? ''));
    setSelectedZoneId((current) => nextZones.some((entry) => entry.id === current) ? current : (nextZones[0]?.id ?? ''));
    setSelectedPlayerId((current) => nextPlayers.some((entry) => entry.id === current) ? current : (nextPlayers[0]?.id ?? ''));
  }, [hydrateTeamEdits]);

  const loadPanel = useCallback(async (preferredGameId?: string | null) => {
    setStatus('loading');
    setErrorMessage(null);

    try {
      const [nextGames, nextMaps, nextChallengeSets] = await Promise.all([
        listGames(),
        listMaps(),
        listChallengeSets(),
      ]);

      setGames(nextGames);
      setMaps(nextMaps);
      setChallengeSets(nextChallengeSets);

      const resolvedGameId = preferredGameId?.trim() || nextGames[0]?.id || null;
      setSelectedGameId(resolvedGameId);
      syncRoute(resolvedGameId);

      if (!resolvedGameId) {
        setCurrentGame(null);
        setGameForm({
          ...INITIAL_GAME_FORM,
          mapId: nextMaps[0]?.id ?? '',
          challengeSetId: nextChallengeSets[0]?.id ?? '',
          city: nextMaps[0]?.city ?? '',
        });
        setTeams([]);
        setPlayers([]);
        setZones([]);
        setChallenges([]);
        setScoreboard([]);
        setSelectedChallengeId('');
        setSelectedZoneId('');
        setSelectedZoneOwnerTeamId('');
        setSelectedPlayerId('');
        setSelectedPlayerTeamId('');
        setStatus('ready');
        return;
      }

      await loadGameBundle(resolvedGameId);
      setStatus('ready');
    } catch (error) {
      setStatus('error');
      setErrorMessage(getApiErrorMessage(error));
    }
  }, [loadGameBundle, syncRoute]);

  const refreshCurrentGame = useCallback(async () => {
    if (!selectedGameId) {
      return;
    }

    setIsRefreshing(true);
    try {
      const nextGames = await listGames();
      setGames(nextGames);
      await loadGameBundle(selectedGameId);
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsRefreshing(false);
    }
  }, [loadGameBundle, selectedGameId]);

  useEffect(() => {
    void loadPanel(initialGameId);
  }, [initialGameId, loadPanel]);

  useEffect(() => {
    syncRoute(selectedGameId);
  }, [selectedGameId, syncRoute]);

  useEffect(() => {
    if (!selectedMap) {
      return;
    }

    setGameForm((current) => current.city.trim() ? current : { ...current, city: selectedMap.city ?? '' });
  }, [selectedMap]);

  useEffect(() => {
    if (!zones.length) {
      setSelectedZoneOwnerTeamId('');
      return;
    }

    setSelectedZoneOwnerTeamId(zones.find((zone) => zone.id === selectedZoneId)?.ownerTeamId ?? '');
  }, [selectedZoneId, zones]);

  useEffect(() => {
    if (!players.length) {
      setSelectedPlayerTeamId('');
      return;
    }

    setSelectedPlayerTeamId(players.find((player) => player.id === selectedPlayerId)?.teamId ?? '');
  }, [players, selectedPlayerId]);

  const handleSelectGame = async (gameId: string) => {
    setSelectedGameId(gameId);
    setNotice(null);
    setIsRefreshing(true);
    try {
      await loadGameBundle(gameId);
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleCreateDraft = () => {
    setSelectedGameId(null);
    setCurrentGame(null);
    setGameForm({
      ...INITIAL_GAME_FORM,
      mapId: maps[0]?.id ?? '',
      challengeSetId: challengeSets[0]?.id ?? '',
      city: maps[0]?.city ?? '',
    });
    setTeams([]);
    setPlayers([]);
    setZones([]);
    setChallenges([]);
    setScoreboard([]);
    setTeamDraft(INITIAL_TEAM_DRAFT);
    setSelectedChallengeId('');
    setSelectedZoneId('');
    setSelectedZoneOwnerTeamId('');
    setSelectedPlayerId('');
    setSelectedPlayerTeamId('');
    setNotice({ tone: 'info', message: 'Drafting a new game.' });
  };

  const handleSaveGame = async () => {
    const name = gameForm.name.trim();
    if (!name) {
      setNotice({ tone: 'error', message: 'Game name is required.' });
      return;
    }
    if (!gameForm.mapId) {
      setNotice({ tone: 'error', message: 'Choose an authored map.' });
      return;
    }
    if (!gameForm.challengeSetId) {
      setNotice({ tone: 'error', message: 'Choose an authored challenge set.' });
      return;
    }

    setIsSavingGame(true);
    try {
      const settings = buildSettings(gameForm, currentGame?.settings ?? {});
      const payload = {
        name,
        modeKey: gameForm.modeKey,
        city: gameForm.city.trim() || null,
        mapId: gameForm.mapId,
        challengeSetId: gameForm.challengeSetId,
        winCondition: buildWinCondition(gameForm),
        settings,
      };

      const savedGame = currentGame
        ? await updateGameDefinition(currentGame.id, payload)
        : await createGameDefinition(payload);

      setCurrentGame(savedGame);
      setSelectedGameId(savedGame.id);
      setGames((current) => upsertById(current, savedGame));
      await loadGameBundle(savedGame.id);
      setNotice({ tone: 'success', message: currentGame ? 'Game updated.' : 'Game created.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsSavingGame(false);
    }
  };

  const handleLifecycle = async (transition: LifecycleTransition) => {
    if (!currentGame) {
      return;
    }

    const label = transition.charAt(0).toUpperCase() + transition.slice(1);
    if (!window.confirm(label + ' this game?')) {
      return;
    }

    setIsRefreshing(true);
    try {
      const updatedGame = await transitionGameLifecycle(currentGame.id, transition);
      setCurrentGame(updatedGame);
      setGames((current) => upsertById(current, updatedGame));
      await loadGameBundle(updatedGame.id);
      setNotice({ tone: 'success', message: 'Game ' + transition + 'ed.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleCreateTeam = async () => {
    if (!currentGame) {
      setNotice({ tone: 'error', message: 'Create or select a game first.' });
      return;
    }

    const name = teamDraft.name.trim();
    if (!name) {
      setNotice({ tone: 'error', message: 'Team name is required.' });
      return;
    }

    setIsCreatingTeam(true);
    try {
      const team = await createTeamDefinition(currentGame.id, {
        name,
        color: teamDraft.color,
      });
      const nextTeams = [...teams, team];
      setTeams(nextTeams);
      hydrateTeamEdits(nextTeams);
      setTeamDraft(INITIAL_TEAM_DRAFT);
      setNotice({ tone: 'success', message: 'Team created.' });
      await refreshCurrentGame();
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsCreatingTeam(false);
    }
  };

  const handleSaveTeam = async (teamId: string) => {
    const draft = teamEdits[teamId];
    if (!draft) {
      return;
    }

    try {
      const updated = await updateTeamDefinition(teamId, {
        name: draft.name.trim(),
        color: draft.color,
      });
      const nextTeams = teams.map((team) => team.id === teamId ? updated : team);
      setTeams(nextTeams);
      hydrateTeamEdits(nextTeams);
      setNotice({ tone: 'success', message: 'Team updated.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    }
  };

  const handleAssignZoneOwner = async () => {
    if (!selectedZoneId) {
      setNotice({ tone: 'error', message: 'Select a zone first.' });
      return;
    }

    try {
      await adminAssignZoneOwner(selectedZoneId, selectedZoneOwnerTeamId || null);
      await refreshCurrentGame();
      setNotice({ tone: 'success', message: 'Zone owner updated.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    }
  };

  const handleMovePlayer = async () => {
    if (!selectedPlayerId) {
      setNotice({ tone: 'error', message: 'Select a player first.' });
      return;
    }

    try {
      await adminMovePlayerTeam(selectedPlayerId, selectedPlayerTeamId || null);
      await refreshCurrentGame();
      setNotice({ tone: 'success', message: 'Player moved.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    }
  };

  const handleForceComplete = async () => {
    if (!selectedChallengeId) {
      setNotice({ tone: 'error', message: 'Select a challenge first.' });
      return;
    }

    if (!window.confirm('Force-complete the selected challenge?')) {
      return;
    }

    try {
      await adminForceCompleteChallenge(selectedChallengeId);
      await refreshCurrentGame();
      setNotice({ tone: 'success', message: 'Challenge force-completed.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    }
  };

  const handleResetChallenge = async () => {
    if (!selectedChallengeId) {
      setNotice({ tone: 'error', message: 'Select a challenge first.' });
      return;
    }

    if (!window.confirm('Reset the selected challenge?')) {
      return;
    }

    try {
      await adminResetChallenge(selectedChallengeId);
      await refreshCurrentGame();
      setNotice({ tone: 'success', message: 'Challenge reset.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    }
  };

  const handleRebroadcast = async () => {
    if (!currentGame) {
      return;
    }

    try {
      await adminRebroadcastGameState(currentGame.id);
      setNotice({ tone: 'success', message: 'Realtime state rebroadcast.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    }
  };

  const selectedChallenge = challenges.find((challenge) => challenge.id === selectedChallengeId) ?? null;
  const selectedZone = zones.find((zone) => zone.id === selectedZoneId) ?? null;
  const selectedPlayer = players.find((player) => player.id === selectedPlayerId) ?? null;

  if (status === 'loading') {
    return <AdminLoading />;
  }

  if (status === 'error') {
    return (
      <main className="min-h-screen bg-[#eef1f3] px-6 py-10 text-[#182126]">
        <section className="mx-auto max-w-3xl rounded-3xl border border-[#c9d2d7] bg-white px-8 py-10 shadow-[0_20px_60px_rgba(21,31,37,0.08)]">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[#68757d]">Admin Panel</p>
          <h1 className="mt-3 text-3xl font-semibold text-[#182126]">Failed to load the control room</h1>
          <p className="mt-4 text-sm text-[#4e5a61]">{errorMessage ?? 'The admin panel could not load.'}</p>
          <button
            type="button"
            onClick={() => { void loadPanel(selectedGameId); }}
            className="mt-6 rounded-full border border-[#1f2f36] bg-[#1f2f36] px-4 py-2 text-sm font-semibold text-white"
          >
            Retry
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#eef1f3] px-4 py-4 text-[#182126] md:px-6 lg:px-8">
      <div className="mx-auto grid max-w-[1800px] gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="rounded-[1.75rem] border border-[#cbd3d8] bg-white p-4 shadow-[0_20px_50px_rgba(21,31,37,0.08)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.3em] text-[#718089]">Admin</p>
              <h1 className="mt-2 text-2xl font-semibold text-[#182126]">Game Control</h1>
              <p className="mt-2 text-sm text-[#5b6870]">Desktop-first management for authored maps, challenge sets, and live Territory sessions.</p>
            </div>
            <button
              type="button"
              onClick={handleCreateDraft}
              className="rounded-full border border-[#1f2f36] px-3 py-2 text-xs font-semibold uppercase tracking-[0.15em] text-[#1f2f36]"
            >
              New Game
            </button>
          </div>

          <div className="mt-4 rounded-2xl border border-[#d5dde2] bg-[#f5f7f8] px-3 py-2 text-xs text-[#57636a]">
            Local admin auth is disabled in this build. Reintroduce it when the deployment boundary matters.
          </div>

          <div className="mt-4 rounded-2xl border border-[#d9e1e6] bg-[#f8fafb] p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">Library Tools</p>
            <div className="mt-3 grid gap-2">
              <a
                href="/admin/zones"
                className="rounded-xl border border-[#d4dce1] bg-white px-3 py-2 text-sm font-semibold text-[#1f2f36] transition hover:border-[#aab8c0] hover:bg-[#fbfcfc]"
              >
                Open Zone Editor
              </a>
              <a
                href="/admin/challenges"
                className="rounded-xl border border-[#d4dce1] bg-white px-3 py-2 text-sm font-semibold text-[#1f2f36] transition hover:border-[#aab8c0] hover:bg-[#fbfcfc]"
              >
                Open Challenge Keeper
              </a>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">Games</p>
            <button
              type="button"
              onClick={() => { void loadPanel(selectedGameId); }}
              className="text-xs font-semibold uppercase tracking-[0.18em] text-[#41535c]"
            >
              Refresh
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {games.map((game) => (
              <button
                key={game.id}
                type="button"
                onClick={() => { void handleSelectGame(game.id); }}
                className={[
                  'w-full rounded-2xl border px-3 py-3 text-left transition',
                  selectedGameId === game.id
                    ? 'border-[#1f2f36] bg-[#1f2f36] text-white'
                    : 'border-[#d8e0e5] bg-[#f8fafb] text-[#1d2830] hover:border-[#aab8c0] hover:bg-white',
                ].join(' ')}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{game.name}</p>
                    <p className={selectedGameId === game.id ? 'mt-1 text-xs text-white/76' : 'mt-1 text-xs text-[#60707a]'}>{game.city ?? 'No city'}</p>
                  </div>
                  <StatusBadge status={game.status} />
                </div>
              </button>
            ))}
            {games.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#c7d0d6] bg-[#f8fafb] px-3 py-6 text-sm text-[#60707a]">
                No games yet. Create the first draft from the setup form.
              </div>
            ) : null}
          </div>
        </aside>

        <section className="space-y-4">
          {notice ? <NoticeBanner notice={notice} onDismiss={() => { setNotice(null); }} /> : null}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)]">
            <PanelCard
              title={currentGame ? 'Game Setup' : 'New Game Wizard'}
              subtitle={currentGame ? 'Maps and challenge sets are authored assets. This view binds them into a runnable game.' : 'Choose the authored map and challenge set that define this game.'}
              action={
                selectedGameId ? (
                  <div className="flex gap-2">
                    <AnchorPill href={'/game/' + selectedGameId} label="Open Game" />
                    {currentGame?.mapId ? <AnchorPill href={'/admin/zones?mapId=' + currentGame.mapId} label="Map" /> : null}
                    {currentGame?.challengeSetId ? <AnchorPill href={'/admin/challenges?setId=' + currentGame.challengeSetId} label="Challenges" /> : null}
                  </div>
                ) : null
              }
            >
              <div className="grid gap-4 lg:grid-cols-2">
                <Field label="Game Name">
                  <input
                    value={gameForm.name}
                    onChange={(event) => { setGameForm((current) => ({ ...current, name: event.target.value })); }}
                    className={inputClassName}
                    placeholder="Toronto Opening Night"
                  />
                </Field>
                <Field label="City">
                  <input
                    value={gameForm.city}
                    onChange={(event) => { setGameForm((current) => ({ ...current, city: event.target.value })); }}
                    className={inputClassName}
                    placeholder="Toronto"
                  />
                </Field>
                <Field label="Mode">
                  <select
                    value={gameForm.modeKey}
                    onChange={(event) => { setGameForm((current) => ({ ...current, modeKey: event.target.value as Game['modeKey'] })); }}
                    className={inputClassName}
                  >
                    <option value="territory">Territory</option>
                  </select>
                </Field>
                <Field label="Map">
                  <select
                    value={gameForm.mapId}
                    onChange={(event) => { setGameForm((current) => ({ ...current, mapId: event.target.value })); }}
                    className={inputClassName}
                    disabled={!canEditSetupBindings}
                  >
                    <option value="">Select a map</option>
                    {maps.map((map) => (
                      <option key={map.id} value={map.id}>{map.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Challenge Set">
                  <select
                    value={gameForm.challengeSetId}
                    onChange={(event) => { setGameForm((current) => ({ ...current, challengeSetId: event.target.value })); }}
                    className={inputClassName}
                    disabled={!canEditSetupBindings}
                  >
                    <option value="">Select a set</option>
                    {challengeSets.map((challengeSet) => (
                      <option key={challengeSet.id} value={challengeSet.id}>{challengeSet.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Active Deck Size">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={gameForm.activeChallengeCount}
                    onChange={(event) => { setGameForm((current) => ({ ...current, activeChallengeCount: event.target.value })); }}
                    className={inputClassName}
                  />
                </Field>
                <Field label="Win Condition">
                  <select
                    value={gameForm.winConditionType}
                    onChange={(event) => { setGameForm((current) => ({ ...current, winConditionType: event.target.value as WinConditionKind })); }}
                    className={inputClassName}
                  >
                    <option value="all_zones">All zones</option>
                    <option value="zone_majority">Zone majority</option>
                    <option value="time_limit">Time limit</option>
                  </select>
                </Field>
                {gameForm.winConditionType === 'zone_majority' ? (
                  <Field label="Majority Threshold (%)">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      value={gameForm.zoneMajorityThreshold}
                      onChange={(event) => { setGameForm((current) => ({ ...current, zoneMajorityThreshold: event.target.value })); }}
                      className={inputClassName}
                    />
                  </Field>
                ) : null}
                {gameForm.winConditionType === 'time_limit' ? (
                  <Field label="Time Limit (minutes)">
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={gameForm.timeLimitMinutes}
                      onChange={(event) => { setGameForm((current) => ({ ...current, timeLimitMinutes: event.target.value })); }}
                      className={inputClassName}
                    />
                  </Field>
                ) : null}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-4 rounded-2xl border border-[#dde4e8] bg-[#f8fafb] px-4 py-3">
                <label className="flex items-center gap-3 text-sm font-medium text-[#21313a]">
                  <input
                    type="checkbox"
                    checked={gameForm.requireGpsAccuracy}
                    onChange={(event) => { setGameForm((current) => ({ ...current, requireGpsAccuracy: event.target.checked })); }}
                    className="h-4 w-4 rounded border-[#9aabb5]"
                  />
                  Require GPS accuracy gate
                </label>
                <label className="flex items-center gap-3 text-sm font-medium text-[#21313a]">
                  <input
                    type="checkbox"
                    checked={gameForm.broadcastTeamLocations}
                    onChange={(event) => { setGameForm((current) => ({ ...current, broadcastTeamLocations: event.target.checked })); }}
                    className="h-4 w-4 rounded border-[#9aabb5]"
                  />
                  Broadcast team locations
                </label>
                {selectedMap ? <MetaPill label={'Map center ' + selectedMap.centerLat.toFixed(3) + ', ' + selectedMap.centerLng.toFixed(3)} /> : null}
                {selectedChallengeSet ? <MetaPill label={selectedChallengeSet.name} /> : null}
                {currentGame ? <StatusBadge status={currentGame.status} /> : null}
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => { void handleSaveGame(); }}
                  disabled={isSavingGame}
                  className="rounded-full bg-[#1f2f36] px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#7b8a92]"
                >
                  {isSavingGame ? 'Saving…' : currentGame ? 'Save Game' : 'Create Game'}
                </button>
                {!canEditSetupBindings && currentGame ? (
                  <p className="text-sm text-[#5f6d74]">Map and challenge set bindings lock once the game leaves setup.</p>
                ) : null}
              </div>
            </PanelCard>

            <PanelCard title="Lifecycle" subtitle="Runtime cloning happens when the game starts. Use lifecycle controls from here after the authored assets are ready.">
              <div className="space-y-3">
                <LifecycleRow
                  label="Start"
                  description="Clone the authored map and challenge set into runtime zones and challenges."
                  disabled={!currentGame || currentGame.status !== 'setup' || isRefreshing}
                  onClick={() => { void handleLifecycle('start'); }}
                />
                <LifecycleRow
                  label="Pause"
                  description="Freeze gameplay while keeping current ownership and runtime state."
                  disabled={!currentGame || currentGame.status !== 'active' || isRefreshing}
                  onClick={() => { void handleLifecycle('pause'); }}
                />
                <LifecycleRow
                  label="Resume"
                  description="Return a paused game to live play."
                  disabled={!currentGame || currentGame.status !== 'paused' || isRefreshing}
                  onClick={() => { void handleLifecycle('resume'); }}
                />
                <LifecycleRow
                  label="End"
                  description="Close the current session."
                  disabled={!currentGame || currentGame.status === 'completed' || isRefreshing}
                  onClick={() => { void handleLifecycle('end'); }}
                />
              </div>
            </PanelCard>
          </div>

          <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <PanelCard title="Teams" subtitle="Join codes stay visible here. Team edits are inline and player counts update from the current roster.">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="space-y-3">
                  {teams.map((team) => {
                    const draft = teamEdits[team.id] ?? { name: team.name, color: team.color };
                    const playerCount = playerCountByTeamId.get(team.id) ?? 0;
                    return (
                      <div key={team.id} className="rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <span className="h-4 w-4 rounded-full border border-black/10" style={{ backgroundColor: draft.color }} />
                            <input
                              value={draft.name}
                              onChange={(event) => {
                                const value = event.target.value;
                                setTeamEdits((current) => ({ ...current, [team.id]: { ...draft, name: value } }));
                              }}
                              className="min-w-0 flex-1 rounded-xl border border-[#cfd9de] bg-white px-3 py-2 text-sm font-semibold text-[#182126]"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => { void handleSaveTeam(team.id); }}
                            className="rounded-full border border-[#20323a] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-[#20323a]"
                          >
                            Save
                          </button>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-[#d8e0e5] bg-white px-3 py-1 text-xs font-semibold text-[#31414a]">Code {team.joinCode}</span>
                          <span className="rounded-full border border-[#d8e0e5] bg-white px-3 py-1 text-xs font-semibold text-[#31414a]">Players {playerCount}</span>
                          <input
                            type="color"
                            value={draft.color}
                            onChange={(event) => {
                              const value = event.target.value;
                              setTeamEdits((current) => ({ ...current, [team.id]: { ...draft, color: value } }));
                            }}
                            className="h-9 w-12 rounded-lg border border-[#d0d8dd] bg-white p-1"
                            aria-label={'Color for ' + team.name}
                          />
                        </div>
                      </div>
                    );
                  })}
                  {teams.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-[#cad3d9] bg-[#f8fafb] px-4 py-8 text-sm text-[#5d6a72]">
                      No teams yet. Add the first team from the create form.
                    </div>
                  ) : null}
                </div>

                <div className="rounded-2xl border border-[#d9e1e6] bg-[#f8fafb] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[#718089]">Create Team</p>
                  <div className="mt-4 space-y-3">
                    <Field label="Team Name">
                      <input
                        value={teamDraft.name}
                        onChange={(event) => { setTeamDraft((current) => ({ ...current, name: event.target.value })); }}
                        className={inputClassName}
                        placeholder="Blue Line"
                      />
                    </Field>
                    <Field label="Color">
                      <div className="flex flex-wrap gap-2">
                        {TEAM_COLOR_SWATCHES.map((color) => (
                          <button
                            key={color}
                            type="button"
                            onClick={() => { setTeamDraft((current) => ({ ...current, color })); }}
                            className={[
                              'h-9 w-9 rounded-full border-2 transition',
                              teamDraft.color === color ? 'border-[#182126]' : 'border-transparent',
                            ].join(' ')}
                            style={{ backgroundColor: color }}
                            aria-label={'Use color ' + color}
                          />
                        ))}
                      </div>
                    </Field>
                    <button
                      type="button"
                      onClick={() => { void handleCreateTeam(); }}
                      disabled={!currentGame || isCreatingTeam}
                      className="w-full rounded-full bg-[#1f2f36] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#7b8a92]"
                    >
                      {isCreatingTeam ? 'Creating…' : 'Add Team'}
                    </button>
                  </div>
                </div>
              </div>
            </PanelCard>

            <PanelCard title="Standings" subtitle="Zone-only Territory ranking. This is the same scoreboard the live client consumes.">
              <div className="space-y-2">
                {scoreboard.map((entry) => (
                  <div key={entry.team.id} className="flex items-center justify-between rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-semibold text-[#596870]">#{entry.rank}</span>
                      <span className="h-3.5 w-3.5 rounded-full border border-black/10" style={{ backgroundColor: entry.team.color }} />
                      <div>
                        <p className="text-sm font-semibold text-[#182126]">{entry.team.name}</p>
                        <p className="text-xs text-[#64727a]">{playerCountByTeamId.get(entry.team.id) ?? 0} players</p>
                      </div>
                    </div>
                    <p className="text-sm font-semibold text-[#182126]">Zones {entry.zoneCount}</p>
                  </div>
                ))}
                {scoreboard.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-[#cad3d9] bg-[#f8fafb] px-4 py-8 text-sm text-[#5d6a72]">
                    Scoreboard will populate once the game has teams.
                  </div>
                ) : null}
              </div>
            </PanelCard>
          </div>

          <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <PanelCard title="Overrides" subtitle="Operational fixes. These write straight into live game state and broadcast to connected clients.">
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">Challenges</p>
                  <div className="mt-3 space-y-3">
                    <select
                      value={selectedChallengeId}
                      onChange={(event) => { setSelectedChallengeId(event.target.value); }}
                      className={inputClassName}
                    >
                      <option value="">Select challenge</option>
                      {challenges.map((challenge) => (
                        <option key={challenge.id} value={challenge.id}>{challenge.title} — {challenge.status}</option>
                      ))}
                    </select>
                    {selectedChallenge ? <p className="text-sm text-[#5f6d74]">{selectedChallenge.description}</p> : null}
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => { void handleForceComplete(); }} disabled={!selectedChallengeId} className={secondaryButtonClassName}>Force Complete</button>
                      <button type="button" onClick={() => { void handleResetChallenge(); }} disabled={!selectedChallengeId} className={secondaryButtonClassName}>Reset</button>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">Zone Owner</p>
                  <div className="mt-3 space-y-3">
                    <select value={selectedZoneId} onChange={(event) => { setSelectedZoneId(event.target.value); }} className={inputClassName}>
                      <option value="">Select zone</option>
                      {zones.map((zone) => (
                        <option key={zone.id} value={zone.id}>{zone.name}</option>
                      ))}
                    </select>
                    <select value={selectedZoneOwnerTeamId} onChange={(event) => { setSelectedZoneOwnerTeamId(event.target.value); }} className={inputClassName}>
                      <option value="">Unclaimed</option>
                      {teams.map((team) => (
                        <option key={team.id} value={team.id}>{team.name}</option>
                      ))}
                    </select>
                    {selectedZone ? <p className="text-sm text-[#5f6d74]">Current owner: {teams.find((team) => team.id === selectedZone.ownerTeamId)?.name ?? 'Unclaimed'}</p> : null}
                    <button type="button" onClick={() => { void handleAssignZoneOwner(); }} disabled={!selectedZoneId} className={secondaryButtonClassName}>Apply Owner</button>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">Players</p>
                  <div className="mt-3 space-y-3">
                    <select value={selectedPlayerId} onChange={(event) => { setSelectedPlayerId(event.target.value); }} className={inputClassName}>
                      <option value="">Select player</option>
                      {players.map((player) => (
                        <option key={player.id} value={player.id}>{player.displayName}</option>
                      ))}
                    </select>
                    <select value={selectedPlayerTeamId} onChange={(event) => { setSelectedPlayerTeamId(event.target.value); }} className={inputClassName}>
                      <option value="">No team</option>
                      {teams.map((team) => (
                        <option key={team.id} value={team.id}>{team.name}</option>
                      ))}
                    </select>
                    {selectedPlayer ? <p className="text-sm text-[#5f6d74]">Current team: {teams.find((team) => team.id === selectedPlayer.teamId)?.name ?? 'None'}</p> : null}
                    <button type="button" onClick={() => { void handleMovePlayer(); }} disabled={!selectedPlayerId} className={secondaryButtonClassName}>Move Player</button>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">Realtime</p>
                  <div className="mt-3 space-y-3">
                    <p className="text-sm text-[#5f6d74]">Use this if clients drift or reconnect after major admin edits.</p>
                    <button type="button" onClick={() => { void handleRebroadcast(); }} disabled={!currentGame} className={secondaryButtonClassName}>Rebroadcast State</button>
                    <button type="button" onClick={() => { void refreshCurrentGame(); }} disabled={!currentGame || isRefreshing} className={secondaryButtonClassName}>Refresh Data</button>
                  </div>
                </div>
              </div>
            </PanelCard>

            <PanelCard title="Runtime Snapshot" subtitle="Read-only view of what the active game is carrying right now after authored assets were cloned in.">
              <div className="grid gap-4 md:grid-cols-3">
                <StatBlock label="Zones" value={String(zones.length)} meta={currentGame?.mapId ? 'from authored map' : 'manual'} />
                <StatBlock label="Challenges" value={String(challenges.length)} meta={currentGame?.challengeSetId ? 'from authored set' : 'manual'} />
                <StatBlock label="Players" value={String(players.length)} meta={teams.length + ' teams'} />
              </div>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <CompactList
                  title="Zones"
                  items={zones.map((zone) => ({
                    id: zone.id,
                    label: zone.name,
                    meta: teams.find((team) => team.id === zone.ownerTeamId)?.name ?? 'Unclaimed',
                    tone: teams.find((team) => team.id === zone.ownerTeamId)?.color ?? '#c4cbcf',
                  }))}
                />
                <CompactList
                  title="Challenges"
                  items={challenges.map((challenge) => ({
                    id: challenge.id,
                    label: challenge.title,
                    meta: challenge.status === 'available' ? (challenge.isDeckActive ? 'active' : 'queued') : challenge.status,
                    tone: challenge.status === 'completed' ? '#2E6F57' : challenge.status === 'claimed' ? '#C14C33' : challenge.isDeckActive ? '#c8a86b' : '#c4cbcf',
                  }))}
                />
              </div>
            </PanelCard>
          </div>
        </section>
      </div>
    </main>
  );
}

function buildGameForm(game: Game): GameFormState {
  const winCondition = normalizeWinCondition(game.winCondition);
  const settings = game.settings as GameSettings;

  return {
    name: game.name,
    city: game.city ?? '',
    modeKey: game.modeKey,
    mapId: game.mapId ?? '',
    challengeSetId: game.challengeSetId ?? '',
    winConditionType: winCondition.type,
    zoneMajorityThreshold: winCondition.type === 'zone_majority' ? String(winCondition.threshold) : '60',
    timeLimitMinutes: winCondition.type === 'time_limit' ? String(winCondition.duration_minutes) : '60',
    activeChallengeCount: String(settings.active_challenge_count ?? 3),
    requireGpsAccuracy: Boolean(settings.require_gps_accuracy),
    broadcastTeamLocations: Boolean(settings.broadcast_team_locations),
  };
}

function normalizeWinCondition(winCondition: Game['winCondition']): Extract<WinCondition, { type: WinConditionKind }> {
  const first = winCondition[0];
  if (!first || first.type === 'score_threshold') {
    return { type: 'all_zones' };
  }
  if (first.type === 'zone_majority') {
    return { type: 'zone_majority', threshold: first.threshold };
  }
  if (first.type === 'time_limit') {
    return { type: 'time_limit', duration_minutes: first.duration_minutes };
  }
  return { type: 'all_zones' };
}

function buildWinCondition(form: GameFormState): WinCondition[] {
  switch (form.winConditionType) {
    case 'zone_majority':
      return [{ type: 'zone_majority', threshold: Math.max(1, Number(form.zoneMajorityThreshold) || 1) }];
    case 'time_limit':
      return [{ type: 'time_limit', duration_minutes: Math.max(1, Number(form.timeLimitMinutes) || 1) }];
    default:
      return [{ type: 'all_zones' }];
  }
}

function buildSettings(form: GameFormState, existing: JsonObject): JsonObject {
  const next: JsonObject = { ...existing };
  delete next.claim_timeout_minutes;
  next.active_challenge_count = Math.max(1, Number(form.activeChallengeCount) || 1);
  next.require_gps_accuracy = form.requireGpsAccuracy;
  next.broadcast_team_locations = form.broadcastTeamLocations;
  return next;
}

function upsertById<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const exists = items.some((item) => item.id === nextItem.id);
  if (!exists) {
    return [nextItem, ...items];
  }
  return items.map((item) => item.id === nextItem.id ? nextItem : item);
}

function getApiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : 'Request failed.';
}

function AdminLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#eef1f3] px-6 text-[#182126]">
      <div className="rounded-[1.75rem] border border-[#c9d2d7] bg-white px-8 py-7 text-center shadow-[0_20px_60px_rgba(21,31,37,0.08)]">
        <p className="text-xs font-semibold uppercase tracking-[0.32em] text-[#68757d]">Admin Panel</p>
        <p className="mt-3 text-sm text-[#526067]">Loading control data.</p>
      </div>
    </main>
  );
}

function PanelCard(props: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[1.75rem] border border-[#cbd3d8] bg-white p-5 shadow-[0_20px_50px_rgba(21,31,37,0.08)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[#182126]">{props.title}</h2>
          {props.subtitle ? <p className="mt-1 text-sm text-[#5b6870]">{props.subtitle}</p> : null}
        </div>
        {props.action}
      </div>
      <div className="mt-5">{props.children}</div>
    </section>
  );
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-[#718089]">{props.label}</span>
      {props.children}
    </label>
  );
}

function StatusBadge(props: { status: Game['status'] }) {
  const tone = {
    setup: 'border-[#cfd6db] bg-[#f5f7f8] text-[#58666f]',
    active: 'border-[#c9dfd4] bg-[#edf7f1] text-[#2f6d57]',
    paused: 'border-[#ead9bb] bg-[#faf4e6] text-[#9f6f0a]',
    completed: 'border-[#d9dce1] bg-[#f1f3f5] text-[#59636a]',
  }[props.status];

  return (
    <span className={['rounded-full border px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.14em]', tone].join(' ')}>
      {props.status}
    </span>
  );
}

function MetaPill(props: { label: string }) {
  return <span className="rounded-full border border-[#d6dee3] bg-white px-3 py-1 text-xs font-semibold text-[#43525b]">{props.label}</span>;
}

function LifecycleRow(props: { label: string; description: string; disabled: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] px-4 py-3">
      <div>
        <p className="text-sm font-semibold text-[#182126]">{props.label}</p>
        <p className="mt-1 text-sm text-[#5f6d74]">{props.description}</p>
      </div>
      <button type="button" onClick={props.onClick} disabled={props.disabled} className={secondaryButtonClassName}>
        {props.label}
      </button>
    </div>
  );
}

function NoticeBanner(props: { notice: NoticeState; onDismiss: () => void }) {
  const toneClass = {
    info: 'border-[#ced9df] bg-[#f4f8fa] text-[#31414a]',
    success: 'border-[#c9dfd4] bg-[#edf7f1] text-[#2f6d57]',
    error: 'border-[#ecc7c0] bg-[#fff1ee] text-[#8f3020]',
  }[props.notice.tone];

  return (
    <div className={['flex items-start justify-between gap-4 rounded-2xl border px-4 py-3', toneClass].join(' ')}>
      <p className="text-sm font-medium">{props.notice.message}</p>
      <button type="button" onClick={props.onDismiss} className="text-xs font-semibold uppercase tracking-[0.18em]">Dismiss</button>
    </div>
  );
}

function AnchorPill(props: { href: string; label: string }) {
  return (
    <a href={props.href} className="rounded-full border border-[#d4dce1] bg-[#f8fafb] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[#33434c]">
      {props.label}
    </a>
  );
}

function StatBlock(props: { label: string; value: string; meta: string }) {
  return (
    <div className="rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] px-4 py-4">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">{props.label}</p>
      <p className="mt-2 text-3xl font-semibold text-[#182126]">{props.value}</p>
      <p className="mt-1 text-sm text-[#5f6d74]">{props.meta}</p>
    </div>
  );
}

function CompactList(props: { title: string; items: Array<{ id: string; label: string; meta: string; tone: string }> }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">{props.title}</p>
      <div className="mt-3 max-h-[20rem] space-y-2 overflow-y-auto pr-1">
        {props.items.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-3 rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="h-3 w-3 rounded-full border border-black/10" style={{ backgroundColor: item.tone }} />
              <p className="truncate text-sm font-medium text-[#182126]">{item.label}</p>
            </div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#5f6d74]">{item.meta}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

const inputClassName = 'w-full rounded-xl border border-[#cfd9de] bg-white px-3 py-2.5 text-sm text-[#182126] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none transition focus:border-[#8094a1] focus:ring-2 focus:ring-[#c9d5dc]';
const secondaryButtonClassName = 'rounded-full border border-[#20323a] px-3.5 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#20323a] disabled:cursor-not-allowed disabled:border-[#b5c0c6] disabled:text-[#88969d]';
