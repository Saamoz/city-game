import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { GAME_MODE_KEYS, GAME_MODE_LABELS, PLATFORM_NAME } from '@city-game/shared';
import { BrandMark } from '../../components/BrandMark';
import type {
  Challenge,
  ChallengeSet,
  Game,
  GameSettings,
  JsonObject,
  MapDefinition,
  MapPlayability,
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
  deleteGameDefinition,
  getActiveGame,
  getGame,
  getScoreboard,
  getTeams,
  listChallengeSets,
  listGameChallenges,
  listGames,
  listMaps,
  listMapPlayability,
  listPlayers,
  listZones,
  transitionGameLifecycle,
  updateGameDefinition,
  updateTeamDefinition,
} from '../../lib/api';
import { AdminClue } from './AdminClue';

interface AdminPanelProps {
  initialGameId: string | null;
}

type NoticeTone = 'info' | 'success' | 'error';
type PanelStatus = 'loading' | 'ready' | 'error';
type LifecycleTransition = 'start' | 'pause' | 'resume' | 'end';
type WinConditionKind = 'all_zones' | 'zone_majority' | 'time_limit';
type AdminTab = 'setup' | 'live' | 'results';

interface NoticeState {
  tone: NoticeTone;
  message: string;
}

interface GameFormState {
  name: string;
  modeKey: Game['modeKey'];
  mapId: string;
  challengeSetId: string;
  winConditionType: WinConditionKind;
  zoneMajorityThreshold: string;
  timeLimitMinutes: string;
  activeChallengeCount: string;
  dealAllChallenges: boolean;
  hideFromHome: boolean;
  requireGpsAccuracy: boolean;
  broadcastTeamLocations: boolean;
  allowMidgameJoin: boolean;
  allowReclaimZones: boolean;
}

interface TeamDraftState {
  name: string;
  color: string;
}

const INITIAL_GAME_FORM: GameFormState = {
  name: '',
  modeKey: 'point_challenge',
  mapId: '',
  challengeSetId: '',
  winConditionType: 'all_zones',
  zoneMajorityThreshold: '60',
  timeLimitMinutes: '60',
  activeChallengeCount: '3',
  dealAllChallenges: true,
  hideFromHome: false,
  requireGpsAccuracy: false,
  broadcastTeamLocations: true,
  allowMidgameJoin: true,
  allowReclaimZones: false,
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
  const [isDeletingGame, setIsDeletingGame] = useState(false);
  const [isDeleteGameArmed, setIsDeleteGameArmed] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isHomepagePublishingPending, setIsHomepagePublishingPending] = useState(false);
  const [games, setGames] = useState<Game[]>([]);
  const [maps, setMaps] = useState<MapDefinition[]>([]);
  const [mapPlayability, setMapPlayability] = useState<MapPlayability[]>([]);
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
  const [tab, setTab] = useState<AdminTab>('setup');
  // The game players land on at the site's main address, so the list can flag it.
  const [homepageGameId, setHomepageGameId] = useState<string | null>(null);
  const [isFinishedListOpen, setIsFinishedListOpen] = useState(false);
  const [isSelectingForDelete, setIsSelectingForDelete] = useState(false);
  const [gamesToDelete, setGamesToDelete] = useState<Set<string>>(() => new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isDuplicating, setIsDuplicating] = useState(false);

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

  // Sets written for the chosen map first, then generic ones. The saved set stays listed even if it
  // predates set maps, so the picker never shows blank.
  const challengeSetOptions = useMemo(() => {
    const fitting = challengeSets.filter((entry) => challengeSetFitsMap(entry, gameForm.mapId) || entry.id === gameForm.challengeSetId);
    return [...fitting.filter((entry) => entry.mapId), ...fitting.filter((entry) => !entry.mapId)];
  }, [challengeSets, gameForm.challengeSetId, gameForm.mapId]);
  const playabilityByMapId = useMemo(
    () => new Map(mapPlayability.map((entry) => [entry.mapId, entry])),
    [mapPlayability],
  );
  const firstPlayableMapId = useMemo(
    () => maps.find((map) => playabilityByMapId.get(map.id)?.isPlayable)?.id ?? '',
    [maps, playabilityByMapId],
  );
  const selectedMap = useMemo(() => maps.find((entry) => entry.id === gameForm.mapId) ?? null, [gameForm.mapId, maps]);
  const selectedChallengeSet = useMemo(
    () => challengeSets.find((entry) => entry.id === gameForm.challengeSetId) ?? null,
    [challengeSets, gameForm.challengeSetId],
  );
  const canEditSetupBindings = !currentGame || currentGame.status === 'setup';
  const isPointMode = gameForm.modeKey === 'point_challenge';
  const isGameFormDirty = currentGame ? !isSameForm(gameForm, buildGameForm(currentGame)) : gameForm.name.trim() !== '';
  const dirtyTeamIds = teams.filter((team) => { const draft = teamEdits[team.id]; return draft && (draft.name !== team.name || draft.color !== team.color); }).map((team) => team.id);
  const hasUnsavedChanges = isGameFormDirty || dirtyTeamIds.length > 0 || teamDraft.name.trim() !== '';
  const currentGames = games.filter((game) => game.status !== 'completed');
  const finishedGames = games.filter((game) => game.status === 'completed');

  // Unsaved game settings or team edits are lost when another game is opened, so ask first.
  const confirmDiscard = () => !hasUnsavedChanges || window.confirm('You have unsaved changes' + (currentGame ? ' to ' + currentGame.name : '') + '. Discard them?');

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

  // keepDrafts: a background refresh keeps unsaved game settings and team edits instead of overwriting them.
  const loadGameBundle = useCallback(async (gameId: string, { keepDrafts = false }: { keepDrafts?: boolean } = {}) => {
    const [game, nextTeams, nextPlayers, nextZones, nextChallenges, nextScoreboard] = await Promise.all([
      getGame(gameId),
      getTeams(gameId),
      listPlayers(gameId),
      listZones(gameId),
      listGameChallenges(gameId),
      getScoreboard(gameId),
    ]);

    setCurrentGame(game);
    if (!keepDrafts) {
      setGameForm(buildGameForm(game));
      setTeamDraft({ name: '', color: nextTeamColor(nextTeams, INITIAL_TEAM_DRAFT.color) });
    }
    setTeams(nextTeams);
    setPlayers(nextPlayers);
    setZones(nextZones);
    setChallenges(nextChallenges);
    setScoreboard(nextScoreboard);
    if (keepDrafts) {
      setTeamEdits((current) => Object.fromEntries(nextTeams.map((team) => [team.id, current[team.id] ?? { name: team.name, color: team.color }])));
    } else {
      hydrateTeamEdits(nextTeams);
    }
    setSelectedChallengeId((current) => nextChallenges.some((entry) => entry.id === current) ? current : (nextChallenges[0]?.id ?? ''));
    setSelectedZoneId((current) => nextZones.some((entry) => entry.id === current) ? current : (nextZones[0]?.id ?? ''));
    setSelectedPlayerId((current) => nextPlayers.some((entry) => entry.id === current) ? current : (nextPlayers[0]?.id ?? ''));
    return game;
  }, [hydrateTeamEdits]);

  const loadHomepageGame = useCallback(async () => {
    try {
      setHomepageGameId((await getActiveGame()).id);
    } catch {
      setHomepageGameId(null);
    }
  }, []);

  const loadPanel = useCallback(async (preferredGameId?: string | null) => {
    setStatus('loading');
    setErrorMessage(null);

    try {
      // Map playability is only needed by the map picker and can be slow, so the panel shows without it.
      const playabilityRequest = listMapPlayability();
      playabilityRequest.then(setMapPlayability, () => undefined);
      // A game id in the URL can load alongside the lists instead of after them.
      const knownGameId = preferredGameId?.trim() || null;
      const earlyBundle = knownGameId ? loadGameBundle(knownGameId) : null;
      earlyBundle?.catch(() => undefined);
      void loadHomepageGame();

      const [nextGames, nextMaps, nextChallengeSets] = await Promise.all([
        listGames(),
        listMaps(),
        listChallengeSets(),
      ]);

      setGames(nextGames);
      setMaps(nextMaps);
      setChallengeSets(nextChallengeSets);

      const resolvedGameId = knownGameId || nextGames[0]?.id || null;
      setSelectedGameId(resolvedGameId);
      syncRoute(resolvedGameId);

      if (!resolvedGameId) {
        const nextMapPlayability = await playabilityRequest;
        const draftMapId = nextMaps.find((map) => nextMapPlayability.find((entry) => entry.mapId === map.id)?.isPlayable)?.id ?? '';
        setCurrentGame(null);
        setGameForm({
          ...INITIAL_GAME_FORM,
          mapId: draftMapId,
          challengeSetId: nextChallengeSets.find((entry) => challengeSetFitsMap(entry, draftMapId))?.id ?? '',
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
        setTab('setup');
        setStatus('ready');
        return;
      }

      const loadedGame = await (earlyBundle ?? loadGameBundle(resolvedGameId));
      setTab(tabForStatus(loadedGame.status));
      setStatus('ready');
    } catch (error) {
      setStatus('error');
      setErrorMessage(getApiErrorMessage(error));
    }
  }, [loadGameBundle, loadHomepageGame, syncRoute]);

  const refreshCurrentGame = useCallback(async () => {
    if (!selectedGameId) {
      return;
    }

    setIsRefreshing(true);
    try {
      const nextGames = await listGames();
      setGames(nextGames);
      void loadHomepageGame();
      await loadGameBundle(selectedGameId, { keepDrafts: true });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsRefreshing(false);
    }
  }, [loadGameBundle, loadHomepageGame, selectedGameId]);

  useEffect(() => {
    void loadPanel(initialGameId);
  }, [initialGameId, loadPanel]);

  useEffect(() => {
    syncRoute(selectedGameId);
  }, [selectedGameId, syncRoute]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedChanges]);

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
    if (gameId === selectedGameId || !confirmDiscard()) return;
    setSelectedGameId(gameId);
    setIsDeleteGameArmed(false);
    setNotice(null);
    setIsRefreshing(true);
    try {
      setTab(tabForStatus((await loadGameBundle(gameId)).status));
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleCreateDraft = () => {
    if (!confirmDiscard()) return;
    setTab('setup');
    setIsDeleteGameArmed(false);
    setSelectedGameId(null);
    setCurrentGame(null);
    setGameForm({
      ...INITIAL_GAME_FORM,
      mapId: firstPlayableMapId,
      challengeSetId: challengeSets.find((entry) => challengeSetFitsMap(entry, firstPlayableMapId))?.id ?? '',
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
    setNotice({ tone: 'info', message: 'New game: fill in the details below, then tap Create game.' });
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
    if (!isPointMode && playabilityByMapId.get(gameForm.mapId)?.isPlayable === false) {
      setNotice({ tone: 'error', message: 'Choose a playable map before saving the game.' });
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

    const label = transition === 'end' ? 'Finish' : transition.charAt(0).toUpperCase() + transition.slice(1);
    const confirmation = transition === 'end'
      ? 'Finish this game? This freezes the final score and ends play. Results remain available until you permanently delete the game.'
      : label + ' this game?';
    if (!window.confirm(confirmation)) {
      return;
    }

    setIsRefreshing(true);
    try {
      const updatedGame = await transitionGameLifecycle(currentGame.id, transition);
      setCurrentGame(updatedGame);
      setGames((current) => upsertById(current, updatedGame));
      await loadGameBundle(updatedGame.id);
      setTab(tabForStatus(updatedGame.status));
      void loadHomepageGame();
      const lifecycleMessage = transition === 'end'
        ? 'Game finished. Results and recap are now available.'
        : `Game ${{ start: 'started', pause: 'paused', resume: 'resumed' }[transition as 'start' | 'pause' | 'resume']}.`;
      setNotice({ tone: 'success', message: lifecycleMessage });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleHomepagePublishing = async () => {
    if (!currentGame || currentGame.status !== 'completed') return;
    const isEnabled = currentGame.settings.feature_results_on_home === true;
    setIsHomepagePublishingPending(true);
    try {
      const updatedGame = await updateGameDefinition(currentGame.id, {
        settings: { ...currentGame.settings, feature_results_on_home: !isEnabled },
      });
      setCurrentGame(updatedGame);
      setGames(await listGames());
      setNotice({
        tone: 'success',
        message: !isEnabled
          ? 'This finished game is now shown on the public homepage.'
          : 'This game is no longer featured on the public homepage.',
      });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsHomepagePublishingPending(false);
    }
  };
  const handleDeleteGame = async () => {
    if (!currentGame || currentGame.status === 'active' || currentGame.status === 'paused') {
      return;
    }

    if (!isDeleteGameArmed) {
      setIsDeleteGameArmed(true);
      return;
    }

    const deletedGameName = currentGame.name;
    setIsDeletingGame(true);
    try {
      await deleteGameDefinition(currentGame.id);
      setIsDeleteGameArmed(false);
      await loadPanel(null);
      setNotice({ tone: 'success', message: deletedGameName + ' and all of its runtime data were deleted.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsDeletingGame(false);
    }
  };

  // A new game in setup with this one's settings and teams. Players, progress and clue pictures stay behind.
  const handleDuplicateGame = async () => {
    if (!currentGame || !confirmDiscard()) return;
    setIsDuplicating(true);
    try {
      const { feature_results_on_home: _featured, challenge_total_count: _total, ...settings } = currentGame.settings as JsonObject;
      const copy = await createGameDefinition({
        name: currentGame.name + ' (copy)',
        modeKey: currentGame.modeKey,
        mapId: currentGame.mapId,
        challengeSetId: currentGame.challengeSetId,
        winCondition: currentGame.winCondition,
        settings,
      });
      for (const team of teams) {
        await createTeamDefinition(copy.id, { name: team.name, color: team.color });
      }
      setGames(await listGames());
      setSelectedGameId(copy.id);
      setIsDeleteGameArmed(false);
      await loadGameBundle(copy.id);
      setTab('setup');
      setNotice({ tone: 'success', message: 'Created ' + copy.name + (teams.length ? ' with ' + teams.length + ' teams.' : '.') + ' Rename it and add clue pictures before starting.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsDuplicating(false);
    }
  };

  const handleBulkDelete = async () => {
    const ids = finishedGames.filter((game) => gamesToDelete.has(game.id)).map((game) => game.id);
    if (!ids.length || !window.confirm('Permanently delete ' + ids.length + ' finished ' + (ids.length === 1 ? 'game' : 'games') + '? Results, players and history are removed. Maps and challenge sets are kept.')) return;
    setIsBulkDeleting(true);
    try {
      for (const id of ids) await deleteGameDefinition(id);
      setGamesToDelete(new Set());
      setIsSelectingForDelete(false);
      const keepSelected = selectedGameId && !ids.includes(selectedGameId) ? selectedGameId : null;
      await loadPanel(keepSelected);
      setNotice({ tone: 'success', message: 'Deleted ' + ids.length + (ids.length === 1 ? ' game.' : ' games.') });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
      setGames(await listGames().catch(() => games));
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const handleCopyGameLink = async () => {
    if (!currentGame) return;
    const link = window.location.origin + '/game/' + currentGame.id;
    try {
      await navigator.clipboard.writeText(link);
      setNotice({ tone: 'success', message: 'Game link copied: ' + link });
    } catch {
      window.prompt('Copy the game link', link);
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
      setTeams((current) => [...current, team]);
      setTeamEdits((current) => ({ ...current, [team.id]: { name: team.name, color: team.color } }));
      setTeamDraft((current) => ({ name: '', color: nextTeamColor([...teams, team], current.color) }));
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
      setTeams((current) => current.map((team) => team.id === teamId ? updated : team));
      setTeamEdits((current) => ({ ...current, [teamId]: { name: updated.name, color: updated.color } }));
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
  const completedChallengeCount = challenges.filter((challenge) => challenge.status === 'completed').length;
  const isLive = currentGame?.status === 'active' || currentGame?.status === 'paused';
  const isTerritoryGame = currentGame ? currentGame.modeKey === 'territory' : !isPointMode;

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

  const renderGameButton = (game: Game, selectable: boolean) => {
    const isSelected = selectedGameId === game.id;
    const isMarked = gamesToDelete.has(game.id);
    return (
      <button
        key={game.id}
        type="button"
        onClick={() => {
          if (selectable) {
            setGamesToDelete((current) => { const next = new Set(current); if (next.has(game.id)) next.delete(game.id); else next.add(game.id); return next; });
            return;
          }
          void handleSelectGame(game.id);
        }}
        className={[
          'w-full rounded-2xl border px-3 py-3 text-left transition',
          selectable
            ? (isMarked ? 'border-[#b94b3f] bg-[#fff2ef] text-[#1d2830]' : 'border-[#d8e0e5] bg-[#f8fafb] text-[#1d2830]')
            : isSelected
              ? 'border-[#1f2f36] bg-[#1f2f36] text-white'
              : 'border-[#d8e0e5] bg-[#f8fafb] text-[#1d2830] hover:border-[#aab8c0] hover:bg-white',
        ].join(' ')}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            {selectable ? <span aria-hidden="true" className={['mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px]', isMarked ? 'border-[#9b352c] bg-[#9b352c] text-white' : 'border-[#9aabb5] bg-white'].join(' ')}>{isMarked ? '✓' : ''}</span> : null}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{game.name}</p>
              <p className={isSelected && !selectable ? 'mt-1 text-xs text-white/76' : 'mt-1 text-xs text-[#60707a]'}>
                {GAME_MODE_LABELS[game.modeKey]}{game.settings.hide_from_home === true ? ' · test' : ''}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <StatusBadge status={game.status} />
            {homepageGameId === game.id ? <span className="rounded-full bg-[#2f6d57] px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-white">On homepage</span> : null}
          </div>
        </div>
      </button>
    );
  };

  const standingsCard = (
    <PanelCard title={currentGame?.status === 'completed' ? 'Final standings' : 'Standings'}>
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
            <p className="text-sm font-semibold text-[#182126]">{currentGame?.modeKey === 'point_challenge' ? (entry.resources.points ?? 0) + ' pts' : entry.zoneCount + ' zones'}</p>
          </div>
        ))}
        {scoreboard.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#cad3d9] bg-[#f8fafb] px-4 py-8 text-sm text-[#5d6a72]">
            Standings appear once the game has teams.
          </div>
        ) : null}
      </div>
    </PanelCard>
  );

  const clueCard = currentGame ? (
    <AdminClue
      game={currentGame}
      onGameChange={(game) => {
        setCurrentGame(game);
        setGames((current) => upsertById(current, game));
      }}
    />
  ) : null;

  const deleteCard = (
    <PanelCard title="Delete game">
      <p className="text-sm text-[#5f6d74]">Permanently removes results, location history, players, teams and events. Maps and challenge sets are kept.</p>
      <button
        type="button"
        onClick={() => { void handleDeleteGame(); }}
        disabled={!currentGame || isLive || isDeletingGame}
        className="mt-3 rounded-full border border-[#b94b3f] px-4 py-2 text-sm font-semibold text-[#9b352c] transition hover:bg-[#fff2ef] disabled:cursor-not-allowed disabled:border-[#cbd3d8] disabled:text-[#8b969c]"
      >
        {isDeletingGame ? 'Deleting…' : isDeleteGameArmed ? 'Confirm permanent delete' : 'Permanently delete'}
      </button>
      {isLive ? <p className="mt-2 text-xs text-[#7a858b]">Finish the game before deleting it.</p> : null}
    </PanelCard>
  );

  const settingsCard = (
    <PanelCard
      title={currentGame ? 'Game settings' : 'New game'}
      subtitle={currentGame ? undefined : 'Pick the challenge set and how the game ends, then create it. Teams and clue pictures come next.'}
      action={isGameFormDirty && currentGame ? <span className="rounded-full bg-[#faf4e6] px-3 py-1 text-xs font-semibold text-[#9f6f0a]">Unsaved changes</span> : null}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Field label="Game name">
          <input
            value={gameForm.name}
            onChange={(event) => { setGameForm((current) => ({ ...current, name: event.target.value })); }}
            className={inputClassName}
            placeholder="Sagnik's Birthday Hunt"
          />
        </Field>
        <Field label="Mode">
          {canEditSetupBindings ? (
            <select
              value={gameForm.modeKey}
              onChange={(event) => {
                const modeKey = event.target.value as Game['modeKey'];
                // Zone majority only exists in Turf War.
                setGameForm((current) => ({ ...current, modeKey, winConditionType: modeKey === 'point_challenge' && current.winConditionType === 'zone_majority' ? 'all_zones' : current.winConditionType }));
              }}
              className={inputClassName}
            >
              {GAME_MODE_KEYS.map((modeKey) => (
                <option key={modeKey} value={modeKey}>{GAME_MODE_LABELS[modeKey]}</option>
              ))}
            </select>
          ) : <LockedValue value={GAME_MODE_LABELS[gameForm.modeKey]} />}
        </Field>
        <Field label="Map">
          {canEditSetupBindings ? (
            <select
              value={gameForm.mapId}
              onChange={(event) => {
                const mapId = event.target.value;
                // A set written for another city doesn't carry over to the new map.
                setGameForm((current) => {
                  const currentSet = challengeSets.find((entry) => entry.id === current.challengeSetId);
                  return { ...current, mapId, challengeSetId: currentSet && !challengeSetFitsMap(currentSet, mapId) ? '' : current.challengeSetId };
                });
              }}
              className={inputClassName}
            >
              <option value="">Select a map</option>
              {maps.map((map) => {
                // Only Turf War plays on the zones, so only it cares whether they form a valid board.
                const unplayable = !isPointMode && playabilityByMapId.get(map.id)?.isPlayable === false;
                return (
                  <option disabled={unplayable} key={map.id} value={map.id}>
                    {map.name}{unplayable ? ' — ' + mapPlayabilityLabel(playabilityByMapId.get(map.id)?.reason ?? null) : ''}
                  </option>
                );
              })}
            </select>
          ) : <LockedValue value={selectedMap?.name ?? 'No map'} />}
        </Field>
        <Field label="Challenge set">
          {canEditSetupBindings ? (
            <select
              value={gameForm.challengeSetId}
              onChange={(event) => {
                const challengeSetId = event.target.value;
                // A set written for a city brings its map along.
                setGameForm((current) => ({ ...current, challengeSetId, mapId: challengeSets.find((entry) => entry.id === challengeSetId)?.mapId ?? current.mapId }));
              }}
              className={inputClassName}
            >
              <option value="">Select a set</option>
              {challengeSetOptions.map((challengeSet) => (
                <option key={challengeSet.id} value={challengeSet.id}>{challengeSet.name}{challengeSet.mapId ? '' : ' (any city)'}</option>
              ))}
            </select>
          ) : <LockedValue value={selectedChallengeSet?.name ?? 'No set'} />}
        </Field>
        <Field label="Challenges in play">
          <label className="flex items-center gap-2 py-2.5 text-sm font-medium text-[#21313a]">
            <input
              type="checkbox"
              checked={gameForm.dealAllChallenges}
              onChange={(event) => { setGameForm((current) => ({ ...current, dealAllChallenges: event.target.checked })); }}
              className="h-4 w-4 rounded border-[#9aabb5]"
            />
            Show every challenge from the start
          </label>
          {!gameForm.dealAllChallenges ? (
            <div className="flex items-center gap-2 text-sm text-[#21313a]">
              <input
                type="number"
                min={1}
                step={1}
                value={gameForm.activeChallengeCount}
                onChange={(event) => { setGameForm((current) => ({ ...current, activeChallengeCount: event.target.value })); }}
                className={inputClassName + ' w-24'}
              />
              {isPointMode ? 'anywhere challenges at a time (pinned ones always show)' : 'at a time'}
            </div>
          ) : null}
        </Field>
        <Field label="Game ends">
          <select
            value={gameForm.winConditionType}
            onChange={(event) => { setGameForm((current) => ({ ...current, winConditionType: event.target.value as WinConditionKind })); }}
            className={inputClassName}
          >
            {isPointMode ? (
              <>
                <option value="all_zones">When every challenge is done, or when you tap Finish</option>
                <option value="time_limit">After a time limit (or when every challenge is done)</option>
              </>
            ) : (
              <>
                <option value="all_zones">When one team holds every zone</option>
                <option value="zone_majority">When one team holds a share of the zones</option>
                <option value="time_limit">After a time limit</option>
              </>
            )}
          </select>
          {gameForm.winConditionType === 'zone_majority' && !isPointMode ? (
            <div className="mt-2 flex items-center gap-2 text-sm text-[#21313a]">
              <input type="number" min={1} max={100} step={1} value={gameForm.zoneMajorityThreshold} onChange={(event) => { setGameForm((current) => ({ ...current, zoneMajorityThreshold: event.target.value })); }} className={inputClassName + ' w-24'} />
              % of zones
            </div>
          ) : null}
          {gameForm.winConditionType === 'time_limit' ? (
            <div className="mt-2 flex items-center gap-2 text-sm text-[#21313a]">
              <input type="number" min={1} step={1} value={gameForm.timeLimitMinutes} onChange={(event) => { setGameForm((current) => ({ ...current, timeLimitMinutes: event.target.value })); }} className={inputClassName + ' w-24'} />
              minutes from the start (players don't see a countdown)
            </div>
          ) : null}
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-[#dde4e8] bg-[#f8fafb] px-4 py-3">
        <Toggle checked={gameForm.hideFromHome} onChange={(hideFromHome) => { setGameForm((current) => ({ ...current, hideFromHome })); }} label="Test game (hide from homepage)" />
        <Toggle checked={gameForm.allowMidgameJoin} onChange={(allowMidgameJoin) => { setGameForm((current) => ({ ...current, allowMidgameJoin })); }} label="Allow mid-game joins" />
        <Toggle checked={gameForm.broadcastTeamLocations} onChange={(broadcastTeamLocations) => { setGameForm((current) => ({ ...current, broadcastTeamLocations })); }} label="Show other teams on the map" />
        <Toggle checked={gameForm.requireGpsAccuracy} onChange={(requireGpsAccuracy) => { setGameForm((current) => ({ ...current, requireGpsAccuracy })); }} label="Block completions on poor GPS" />
        {!isPointMode ? <Toggle checked={gameForm.allowReclaimZones} onChange={(allowReclaimZones) => { setGameForm((current) => ({ ...current, allowReclaimZones })); }} label="Allow reclaiming zones" /> : null}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => { void handleSaveGame(); }}
          disabled={isSavingGame || (Boolean(currentGame) && !isGameFormDirty)}
          className="rounded-full bg-[#1f2f36] px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#7b8a92]"
        >
          {isSavingGame ? 'Saving…' : currentGame ? (isGameFormDirty ? 'Save changes' : 'Saved') : 'Create game'}
        </button>
        {isGameFormDirty && currentGame ? (
          <button type="button" onClick={() => { setGameForm(buildGameForm(currentGame)); }} className="text-sm font-semibold text-[#5f6d74] underline-offset-2 hover:underline">Discard</button>
        ) : null}
      </div>
    </PanelCard>
  );

  const teamsCard = currentGame ? (
    <PanelCard title="Teams" subtitle="Players pick a team when they open the game link.">
      <div className="space-y-2">
        {teams.map((team) => {
          const draft = teamEdits[team.id] ?? { name: team.name, color: team.color };
          const isDirty = dirtyTeamIds.includes(team.id);
          return (
            <div key={team.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] px-3 py-2">
              <input
                type="color"
                value={draft.color}
                onChange={(event) => {
                  const value = event.target.value;
                  setTeamEdits((current) => ({ ...current, [team.id]: { ...draft, color: value } }));
                }}
                className="h-8 w-10 shrink-0 rounded-lg border border-[#d0d8dd] bg-white p-1"
                aria-label={'Color for ' + team.name}
              />
              <input
                value={draft.name}
                onChange={(event) => {
                  const value = event.target.value;
                  setTeamEdits((current) => ({ ...current, [team.id]: { ...draft, name: value } }));
                }}
                className="min-w-0 flex-1 rounded-xl border border-[#cfd9de] bg-white px-3 py-1.5 text-sm font-semibold text-[#182126]"
              />
              <span className="text-xs font-semibold text-[#5f6d74]">{playerCountByTeamId.get(team.id) ?? 0} players</span>
              {isDirty ? (
                <button type="button" onClick={() => { void handleSaveTeam(team.id); }} className="rounded-full bg-[#1f2f36] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-white">Save</button>
              ) : null}
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-[#cad3d9] bg-[#f8fafb] px-3 py-2">
          <div className="flex gap-1.5">
            {TEAM_COLOR_SWATCHES.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => { setTeamDraft((current) => ({ ...current, color })); }}
                className={['h-7 w-7 rounded-full border-2 transition', teamDraft.color === color ? 'border-[#182126]' : 'border-transparent'].join(' ')}
                style={{ backgroundColor: color }}
                aria-label={'Use color ' + color}
              />
            ))}
          </div>
          <input
            value={teamDraft.name}
            onChange={(event) => { setTeamDraft((current) => ({ ...current, name: event.target.value })); }}
            onKeyDown={(event) => { if (event.key === 'Enter') void handleCreateTeam(); }}
            className="min-w-0 flex-1 rounded-xl border border-[#cfd9de] bg-white px-3 py-1.5 text-sm text-[#182126]"
            placeholder={'Team ' + (teams.length + 1)}
          />
          <button
            type="button"
            onClick={() => { void handleCreateTeam(); }}
            disabled={isCreatingTeam || !teamDraft.name.trim()}
            className="rounded-full bg-[#1f2f36] px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-white disabled:cursor-not-allowed disabled:bg-[#7b8a92]"
          >
            {isCreatingTeam ? 'Adding…' : 'Add team'}
          </button>
        </div>
      </div>
    </PanelCard>
  ) : null;

  const lifecycleBar = currentGame ? (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-[1.75rem] border border-[#cbd3d8] bg-white px-5 py-4 shadow-[0_20px_50px_rgba(21,31,37,0.08)]">
      <div>
        <p className="text-sm font-semibold text-[#182126]">
          {currentGame.status === 'setup' ? 'Not started' : currentGame.status === 'active' ? 'Live' : currentGame.status === 'paused' ? 'Paused' : 'Finished'}
          {challenges.length ? <span className="font-normal text-[#5f6d74]"> · {completedChallengeCount} of {challenges.length} challenges done · {players.length} players</span> : null}
        </p>
        <p className="mt-0.5 text-xs text-[#5f6d74]">
          {currentGame.status === 'setup'
            ? 'Starting copies the challenge set into the game. Teams can still be added afterwards.'
            : currentGame.status === 'completed'
              ? 'Scores are frozen. Judging, the clue reveal and the homepage are under Results.'
              : 'Finish freezes the scores and sends everyone to the results screen.'}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {currentGame.status === 'setup' ? (
          <button
            type="button"
            onClick={() => { void handleLifecycle('start'); }}
            disabled={isRefreshing || isGameFormDirty || (currentGame.modeKey === 'territory' && playabilityByMapId.get(currentGame.mapId ?? '')?.isPlayable === false)}
            title={isGameFormDirty ? 'Save or discard your settings changes first' : undefined}
            className="rounded-full bg-[#2f6d57] px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#9fb5ab]"
          >
            Start game
          </button>
        ) : null}
        {currentGame.status === 'active' ? <button type="button" onClick={() => { void handleLifecycle('pause'); }} disabled={isRefreshing} className={secondaryButtonClassName}>Pause</button> : null}
        {currentGame.status === 'paused' ? <button type="button" onClick={() => { void handleLifecycle('resume'); }} disabled={isRefreshing} className={secondaryButtonClassName}>Resume</button> : null}
        {isLive ? (
          <button type="button" onClick={() => { void handleLifecycle('end'); }} disabled={isRefreshing} className="rounded-full bg-[#9b352c] px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60">Finish game</button>
        ) : null}
      </div>
    </section>
  ) : null;

  const fixesCard = currentGame ? (
    <PanelCard title="Fixes" subtitle="These change the live game straight away and update every phone.">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">Challenge</p>
          <div className="mt-3 space-y-3">
            <select value={selectedChallengeId} onChange={(event) => { setSelectedChallengeId(event.target.value); }} className={inputClassName}>
              <option value="">Select challenge</option>
              {challenges.map((challenge) => (
                <option key={challenge.id} value={challenge.id}>{challenge.title} — {challenge.status}</option>
              ))}
            </select>
            {selectedChallenge ? <p className="text-sm text-[#5f6d74]">{selectedChallenge.description}</p> : null}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => { void handleForceComplete(); }} disabled={!selectedChallengeId} className={secondaryButtonClassName}>Force complete</button>
              <button type="button" onClick={() => { void handleResetChallenge(); }} disabled={!selectedChallengeId} className={secondaryButtonClassName}>Reset</button>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">Player's team</p>
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
            {selectedPlayer ? <p className="text-sm text-[#5f6d74]">Now on: {teams.find((team) => team.id === selectedPlayer.teamId)?.name ?? 'no team'}</p> : null}
            <button type="button" onClick={() => { void handleMovePlayer(); }} disabled={!selectedPlayerId} className={secondaryButtonClassName}>Move player</button>
          </div>
        </div>

        {isTerritoryGame ? (
          <div className="rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">Zone owner</p>
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
              <button type="button" onClick={() => { void handleAssignZoneOwner(); }} disabled={!selectedZoneId} className={secondaryButtonClassName}>Apply owner</button>
            </div>
          </div>
        ) : null}

        <div className="rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">Phones out of sync</p>
          <div className="mt-3 space-y-3">
            <p className="text-sm text-[#5f6d74]">Pushes the full game state to every connected phone.</p>
            <button type="button" onClick={() => { void handleRebroadcast(); }} className={secondaryButtonClassName}>Resend state</button>
          </div>
        </div>
      </div>
    </PanelCard>
  ) : null;

  const challengesCard = (
    <PanelCard title="Challenges" subtitle={challenges.length ? completedChallengeCount + ' of ' + challenges.length + ' done' : 'Challenges are copied in from the set when the game starts.'}>
      <div className="grid gap-4 lg:grid-cols-1">
        <CompactList
          title=""
          items={challenges.map((challenge) => ({
            id: challenge.id,
            label: challenge.title,
            meta: challenge.status === 'available' ? (challenge.isDeckActive ? 'open' : 'queued') : challenge.status === 'completed' ? 'done' : challenge.status,
            tone: challenge.status === 'completed' ? '#2E6F57' : challenge.status === 'claimed' ? '#C14C33' : challenge.isDeckActive ? '#c8a86b' : '#c4cbcf',
          }))}
        />
        {isTerritoryGame && zones.length ? (
          <CompactList
            title="Zones"
            items={zones.map((zone) => ({
              id: zone.id,
              label: zone.name,
              meta: teams.find((team) => team.id === zone.ownerTeamId)?.name ?? 'Unclaimed',
              tone: teams.find((team) => team.id === zone.ownerTeamId)?.color ?? '#c4cbcf',
            }))}
          />
        ) : null}
      </div>
    </PanelCard>
  );

  return (
    <main className="min-h-screen bg-[#eef1f3] px-4 py-4 text-[#182126] md:px-6 lg:px-8">
      <div className="mx-auto grid max-w-[1800px] gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="rounded-[1.75rem] border border-[#cbd3d8] bg-white p-4 shadow-[0_20px_50px_rgba(21,31,37,0.08)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <BrandMark className="h-6 w-6" decorative />
                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.3em] text-[#718089]">{PLATFORM_NAME} Admin</p>
              </div>
              <h1 className="mt-2 text-2xl font-semibold text-[#182126]">Game Control</h1>
            </div>
            <button
              type="button"
              onClick={handleCreateDraft}
              className="rounded-full border border-[#1f2f36] px-3 py-2 text-xs font-semibold uppercase tracking-[0.15em] text-[#1f2f36]"
            >
              New Game
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <a href="/admin/challenges" className="rounded-xl border border-[#d4dce1] bg-[#f8fafb] px-3 py-2 text-center text-sm font-semibold text-[#1f2f36] transition hover:border-[#aab8c0] hover:bg-white">Challenges</a>
            <a href="/admin/zones" className="rounded-xl border border-[#d4dce1] bg-[#f8fafb] px-3 py-2 text-center text-sm font-semibold text-[#1f2f36] transition hover:border-[#aab8c0] hover:bg-white">Maps</a>
          </div>

          <div className="mt-5 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">Games</p>
            <button
              type="button"
              onClick={() => { void (selectedGameId ? refreshCurrentGame() : loadPanel(null)); }}
              disabled={isRefreshing}
              className="text-xs font-semibold uppercase tracking-[0.18em] text-[#41535c] disabled:opacity-50"
            >
              {isRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {currentGames.map((game) => renderGameButton(game, false))}
            {games.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#c7d0d6] bg-[#f8fafb] px-3 py-6 text-sm text-[#60707a]">No games yet. Start one with New Game.</div>
            ) : null}
          </div>

          {finishedGames.length ? (
            <div className="mt-4">
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => { setIsFinishedListOpen((open) => !open); }} className="text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">
                  {isFinishedListOpen ? '▾' : '▸'} Finished ({finishedGames.length})
                </button>
                {isFinishedListOpen ? (
                  <button
                    type="button"
                    onClick={() => { setIsSelectingForDelete((on) => !on); setGamesToDelete(new Set()); }}
                    className="text-xs font-semibold uppercase tracking-[0.18em] text-[#41535c]"
                  >
                    {isSelectingForDelete ? 'Cancel' : 'Select'}
                  </button>
                ) : null}
              </div>
              {isFinishedListOpen ? (
                <div className="mt-3 space-y-2">
                  {finishedGames.map((game) => renderGameButton(game, isSelectingForDelete))}
                  {isSelectingForDelete ? (
                    <button
                      type="button"
                      onClick={() => { void handleBulkDelete(); }}
                      disabled={!gamesToDelete.size || isBulkDeleting}
                      className="w-full rounded-full border border-[#b94b3f] px-4 py-2 text-sm font-semibold text-[#9b352c] disabled:cursor-not-allowed disabled:border-[#cbd3d8] disabled:text-[#8b969c]"
                    >
                      {isBulkDeleting ? 'Deleting…' : 'Delete ' + gamesToDelete.size + ' selected'}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </aside>

        <section className="space-y-4">
          {notice ? <NoticeBanner notice={notice} onDismiss={() => { setNotice(null); }} /> : null}

          {currentGame ? (
            <header className="rounded-[1.75rem] border border-[#cbd3d8] bg-white px-5 pt-4 shadow-[0_20px_50px_rgba(21,31,37,0.08)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-xl font-semibold text-[#182126]">{currentGame.name}</h2>
                    <StatusBadge status={currentGame.status} />
                    {homepageGameId === currentGame.id ? <span className="rounded-full bg-[#2f6d57] px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-white">On homepage</span> : null}
                  </div>
                  <p className="mt-1 text-sm text-[#5f6d74]">{GAME_MODE_LABELS[currentGame.modeKey]} · {selectedChallengeSet?.name ?? 'no challenge set'}{selectedMap ? ' · ' + selectedMap.name : ''}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <AnchorPill href={'/game/' + currentGame.id} label="Open game" />
                  <button type="button" onClick={() => { void handleCopyGameLink(); }} className={pillClassName}>Copy link</button>
                  {currentGame.challengeSetId ? <AnchorPill href={'/admin/challenges?setId=' + currentGame.challengeSetId} label="Edit challenges" /> : null}
                  {currentGame.modeKey === 'territory' && currentGame.mapId ? <AnchorPill href={'/admin/zones?mapId=' + currentGame.mapId} label="Edit map" /> : null}
                  <button type="button" onClick={() => { void handleDuplicateGame(); }} disabled={isDuplicating} className={pillClassName}>{isDuplicating ? 'Duplicating…' : 'Duplicate'}</button>
                </div>
              </div>
              <nav className="mt-4 flex gap-1" aria-label="Game sections">
                {(['setup', 'live', 'results'] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => { setTab(key); }}
                    aria-current={tab === key ? 'page' : undefined}
                    className={['-mb-px rounded-t-xl border-b-2 px-4 py-2 text-sm font-semibold transition', tab === key ? 'border-[#1f2f36] text-[#182126]' : 'border-transparent text-[#6b7980] hover:text-[#182126]'].join(' ')}
                  >
                    {{ setup: 'Setup', live: 'Live', results: 'Results' }[key]}
                    {key === 'setup' && hasUnsavedChanges ? <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-[#d19a1f] align-middle" aria-label="unsaved changes" /> : null}
                  </button>
                ))}
              </nav>
            </header>
          ) : null}

          {!currentGame ? settingsCard : null}

          {currentGame && tab === 'setup' ? (
            <>
              {lifecycleBar}
              <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
                {settingsCard}
                <div className="space-y-4">
                  {teamsCard}
                  {currentGame.status === 'setup' ? clueCard : null}
                </div>
              </div>
              {currentGame.status === 'setup' ? deleteCard : null}
            </>
          ) : null}

          {currentGame && tab === 'live' ? (
            <>
              {lifecycleBar}
              {currentGame.status === 'setup' ? (
                <p className="rounded-2xl border border-dashed border-[#cad3d9] bg-white px-4 py-6 text-sm text-[#5d6a72]">The game hasn't started. Standings, challenge progress and fixes show up here once it's live.</p>
              ) : (
                <>
                  <div className="grid gap-4 2xl:grid-cols-2">
                    {standingsCard}
                    {challengesCard}
                  </div>
                  {isLive ? clueCard : null}
                  {isLive ? fixesCard : null}
                </>
              )}
            </>
          ) : null}

          {currentGame && tab === 'results' ? (
            <>
              {currentGame.status !== 'completed' ? (
                <p className="rounded-2xl border border-dashed border-[#cad3d9] bg-white px-4 py-6 text-sm text-[#5d6a72]">Results open once the game is finished. Finish it from the Live tab.</p>
              ) : null}
              <div className="grid gap-4 2xl:grid-cols-2">
                {standingsCard}
                <div className="space-y-4">
                  {currentGame.modeKey === 'point_challenge' && currentGame.status !== 'setup' ? (
                    <a href={'/admin/judging?gameId=' + currentGame.id} className="flex items-center justify-between gap-4 rounded-[1.75rem] border border-[#cbc3dc] bg-white p-5 shadow-[0_20px_50px_rgba(21,31,37,0.08)] transition hover:border-[#8f80b8]">
                      <div>
                        <h2 className="text-lg font-semibold text-[#182126]">★ Judging</h2>
                        <p className="mt-1 text-sm text-[#5d6a72]">Mark each judged challenge and bonus yes or no. Players wait for results until you publish them.</p>
                      </div>
                      <span className="shrink-0 rounded-full bg-[#3f3360] px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white">Open</span>
                    </a>
                  ) : null}
                  {currentGame.status === 'completed' ? (
                    <PanelCard title="Homepage">
                      <p className="text-sm text-[#5f6d74]">Show this game's results at the main website address. A live or paused game always takes priority.</p>
                      <button
                        type="button"
                        onClick={() => { void handleHomepagePublishing(); }}
                        disabled={isHomepagePublishingPending}
                        className="mt-3 rounded-full border border-[#718991] px-4 py-2 text-sm font-semibold text-[#314952] transition hover:bg-[#f0f5f6] disabled:opacity-50"
                      >
                        {isHomepagePublishingPending ? 'Updating…' : currentGame.settings.feature_results_on_home === true ? 'Remove from homepage' : 'Show results on homepage'}
                      </button>
                    </PanelCard>
                  ) : null}
                </div>
              </div>
              {currentGame.status === 'completed' ? clueCard : null}
              {currentGame.status === 'completed' ? deleteCard : null}
            </>
          ) : null}
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
    modeKey: game.modeKey,
    mapId: game.mapId ?? '',
    challengeSetId: game.challengeSetId ?? '',
    winConditionType: winCondition.type,
    zoneMajorityThreshold: winCondition.type === 'zone_majority' ? String(winCondition.threshold) : '60',
    timeLimitMinutes: winCondition.type === 'time_limit' ? String(winCondition.duration_minutes) : '60',
    activeChallengeCount: String(settings.active_challenge_count ?? 3),
    dealAllChallenges: settings.deal_all_challenges === true,
    hideFromHome: settings.hide_from_home === true,
    requireGpsAccuracy: Boolean(settings.require_gps_accuracy),
    broadcastTeamLocations: settings.broadcast_team_locations !== false,
    allowMidgameJoin: settings.allow_midgame_join !== false,
    allowReclaimZones: settings.allow_reclaim_zones === true,
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
  next.deal_all_challenges = form.dealAllChallenges;
  next.hide_from_home = form.hideFromHome;
  next.require_gps_accuracy = form.requireGpsAccuracy;
  next.broadcast_team_locations = form.broadcastTeamLocations;
  next.allow_midgame_join = form.allowMidgameJoin;
  next.allow_reclaim_zones = form.allowReclaimZones;
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
      {props.status === 'completed' ? 'finished' : props.status}
    </span>
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
  return <a href={props.href} className={pillClassName}>{props.label}</a>;
}

function LockedValue(props: { value: string }) {
  return <p className="rounded-xl border border-[#e1e7ea] bg-[#f5f7f8] px-3 py-2.5 text-sm text-[#43525b]" title="Fixed once the game has started">{props.value}</p>;
}

function Toggle(props: { checked: boolean; onChange(checked: boolean): void; label: string }) {
  return (
    <label className="flex items-center gap-2.5 text-sm font-medium text-[#21313a]">
      <input type="checkbox" checked={props.checked} onChange={(event) => { props.onChange(event.target.checked); }} className="h-4 w-4 rounded border-[#9aabb5]" />
      {props.label}
    </label>
  );
}

function CompactList(props: { title: string; items: Array<{ id: string; label: string; meta: string; tone: string }> }) {
  return (
    <div>
      {props.title ? <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-[#718089]">{props.title}</p> : null}
      <div className="max-h-[24rem] space-y-2 overflow-y-auto pr-1">
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

function tabForStatus(status: Game['status']): AdminTab {
  return status === 'setup' ? 'setup' : status === 'completed' ? 'results' : 'live';
}

function isSameForm(left: GameFormState, right: GameFormState): boolean {
  return (Object.keys(left) as Array<keyof GameFormState>).every((key) => left[key] === right[key]);
}

// The first swatch no team uses yet, so added teams come out in different colours.
function nextTeamColor(existing: Team[], fallback: string): string {
  const used = new Set(existing.map((team) => team.color.toLowerCase()));
  return TEAM_COLOR_SWATCHES.find((color) => !used.has(color.toLowerCase())) ?? fallback;
}

function challengeSetFitsMap(challengeSet: ChallengeSet, mapId: string): boolean {
  return !challengeSet.mapId || challengeSet.mapId === mapId;
}

function mapPlayabilityLabel(reason: MapPlayability['reason']): string {
  if (reason === 'overlaps') return 'Overlapping zones';
  if (reason === 'disconnected') return 'Disconnected zones';
  return 'No zones';
}

const inputClassName = 'w-full rounded-xl border border-[#cfd9de] bg-white px-3 py-2.5 text-sm text-[#182126] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none transition focus:border-[#8094a1] focus:ring-2 focus:ring-[#c9d5dc]';
const pillClassName = 'rounded-full border border-[#d4dce1] bg-[#f8fafb] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[#33434c] disabled:opacity-50';
const secondaryButtonClassName = 'rounded-full border border-[#20323a] px-3.5 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#20323a] disabled:cursor-not-allowed disabled:border-[#b5c0c6] disabled:text-[#88969d]';
