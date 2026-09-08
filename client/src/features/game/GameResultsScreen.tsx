import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import mapboxgl from 'mapbox-gl';
import type { GameRecap, GameRecapMoment, Game, Team, TeamRecapPath, Zone } from '@city-game/shared';
import { getGameRecap, getPublicGameRecap } from '../../lib/api';
import { FeedOverlay, buildFeedEntriesForTeams } from './Phase32Panels';
import { buildRenderedZoneGeometry, collectGeometryPositions } from './mapGeometry';

interface GameResultsScreenProps {
  game: Game;
  teams: Team[];
  zones: Zone[];
  viewerTeam?: Team | null;
  publicAccess?: boolean;
  onLeave?(): void;
}

type ResultsView = 'results' | 'map';

const mapboxToken = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? import.meta.env.MAPBOX_ACCESS_TOKEN ?? '').trim();

export function GameResultsScreen({ game, teams, zones, viewerTeam = null, publicAccess = false, onLeave }: GameResultsScreenProps) {
  const [recap, setRecap] = useState<GameRecap | null>(null);
  const [recapError, setRecapError] = useState<string | null>(null);
  const [progress, setProgress] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [view, setView] = useState<ResultsView>('results');
  const [showFeed, setShowFeed] = useState(false);
  const startedPlaybackAtRef = useRef(0);
  const startedProgressRef = useRef(0);
  const scoreboard = useMemo(() => withTiedRanks(teams.map((team) => ({ team, zoneCount: zones.filter((zone) => zone.ownerTeamId === team.id).length, rank: 0 })).sort((left, right) => right.zoneCount - left.zoneCount || left.team.name.localeCompare(right.team.name))), [teams, zones]);
  const highestZoneCount = scoreboard[0]?.zoneCount ?? 0;
  const winnerIds = useMemo(() => new Set(scoreboard.filter((entry) => entry.zoneCount === highestZoneCount).map((entry) => entry.team.id)), [highestZoneCount, scoreboard]);
  const viewerEntry = scoreboard.find((entry) => entry.team.id === viewerTeam?.id) ?? null;
  const didViewerWin = Boolean(viewerTeam && winnerIds.has(viewerTeam.id));
  const isTie = winnerIds.size > 1;

  useEffect(() => {
    const controller = new AbortController();
    void (publicAccess ? getPublicGameRecap : getGameRecap)(game.id, controller.signal)
      .then(setRecap)
      .catch(() => setRecapError('The movement replay could not be loaded. Final scores and map are still available.'));
    return () => controller.abort();
  }, [game.id, publicAccess]);

  useEffect(() => {
    if (!isPlaying || !recap) return;
    let frame = 0;
    const animate = (now: number) => {
      if (!startedPlaybackAtRef.current) startedPlaybackAtRef.current = now;
      const elapsed = (now - startedPlaybackAtRef.current) / 1_000;
      const next = Math.min(1, startedProgressRef.current + elapsed / recap.playbackDurationSeconds);
      setProgress(next);
      if (next >= 1) {
        setIsPlaying(false);
        startedPlaybackAtRef.current = 0;
        return;
      }
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [isPlaying, recap]);

  const togglePlayback = () => {
    if (!recap) return;
    if (isPlaying) {
      setIsPlaying(false);
      startedPlaybackAtRef.current = 0;
      return;
    }
    const nextProgress = progress >= 0.999 ? 0 : progress;
    setProgress(nextProgress);
    startedProgressRef.current = nextProgress;
    startedPlaybackAtRef.current = 0;
    setIsPlaying(true);
  };

  const seek = (nextProgress: number) => {
    setIsPlaying(false);
    startedPlaybackAtRef.current = 0;
    setProgress(nextProgress);
  };

  const activeMoment = recap ? findActiveMoment(recap, progress) : null;
  const spectatorWinner = scoreboard[0]?.team.name ?? null;
  const title = viewerTeam
    ? didViewerWin ? (isTie ? "It's a draw!" : 'Victory!') : 'Game over'
    : isTie ? "It's a draw!" : spectatorWinner ? `${spectatorWinner} won!` : 'Game over';
  const subtitle = viewerTeam
    ? didViewerWin
      ? isTie
        ? `${viewerTeam.name} tied for first with ${viewerEntry?.zoneCount ?? 0} zones.`
        : `${viewerTeam.name} finished on top with ${viewerEntry?.zoneCount ?? 0} zones.`
      : `${viewerTeam.name} placed ${ordinal(viewerEntry?.rank ?? scoreboard.length)} with ${viewerEntry?.zoneCount ?? 0} zones.`
    : isTie ? `${winnerIds.size} teams tied for first with ${highestZoneCount} zones.` : `${spectatorWinner ?? 'No team'} won with ${highestZoneCount} zones.`;

  return (
    <main className="relative h-[100dvh] overflow-hidden bg-[#d7dedb] text-[#24343a]">
      <ResultsMap progress={progress} recap={recap} teams={teams} zones={zones} />

      {view === 'map' ? (
        <>
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(238,229,207,0.58),transparent_23%,transparent_68%,rgba(31,47,52,0.32))]" />
          <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 px-3 pt-[calc(env(safe-area-inset-top,0px)+0.7rem)] sm:px-6">
            <div className="results-map-paper min-w-0 px-3.5 py-2.5">
              <p className="truncate font-['IBM_Plex_Mono',monospace] text-[9px] font-semibold uppercase tracking-[0.24em] text-[#80652f]">Final map replay</p>
              <p className="mt-0.5 truncate font-[Georgia,Times_New_Roman,serif] text-lg font-semibold text-[#26373c]">{game.name}</p>
            </div>
            <div className="pointer-events-auto flex shrink-0 gap-2">
              <button className="results-map-paper px-3.5 py-2.5 font-['IBM_Plex_Mono',monospace] text-[10px] font-bold uppercase tracking-[0.12em] text-[#31454b] transition hover:-translate-y-0.5" onClick={() => setView('results')} type="button">Score screen</button>
              {onLeave ? <button className="results-map-paper px-3.5 py-2.5 font-['IBM_Plex_Mono',monospace] text-[10px] font-bold uppercase tracking-[0.12em] text-[#31454b]" onClick={onLeave} type="button">Lobby</button> : null}
            </div>
          </header>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.65rem)] sm:px-6 sm:pb-5">
            <section className="results-map-paper pointer-events-auto mx-auto max-w-2xl px-3.5 py-3 sm:px-5">
              <div className="mb-2 flex min-h-5 min-w-0 items-center gap-2 border-b border-dashed border-[#927d50]/45 pb-2">
                {activeMoment ? (
                  <>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-[#eee1c5]" style={{ backgroundColor: colorForTeam(activeMoment.teamId, teams) }} />
                    <p className="truncate font-[Georgia,Times_New_Roman,serif] text-sm font-semibold text-[#293b40]">{activeMoment.title}</p>
                  </>
                ) : <p className="truncate text-[11px] text-[#657176]">{recapError ?? 'Drag through the replay'}</p>}
              </div>
              <div className="flex items-center gap-3">
                <button className="shrink-0 border border-[#263a40] bg-[#2c4147] px-3.5 py-2 font-['IBM_Plex_Mono',monospace] text-[10px] font-bold uppercase tracking-[0.13em] text-[#f4ead2] shadow-[2px_3px_0_rgba(125,98,48,0.22)] disabled:opacity-45" disabled={!recap} onClick={togglePlayback} type="button">
                  {isPlaying ? 'Pause' : progress >= 0.999 ? 'Replay' : 'Play'}
                </button>
                <div className="min-w-0 flex-1">
                  <input aria-label="Replay position" className="block w-full accent-[#8d7138]" disabled={!recap} max="1000" min="0" onChange={(event) => seek(Number(event.target.value) / 1000)} type="range" value={Math.round(progress * 1000)} />
                  <div className="mt-0.5 flex justify-between font-['IBM_Plex_Mono',monospace] text-[9px] uppercase tracking-[0.1em] text-[#687479]">
                    <span>{formatReplayTime(recap, progress)}</span>
                    <span>{recap ? `${recap.playbackDurationSeconds}s replay` : 'Preparing log'}</span>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </>
      ) : (
        <section className="results-atlas-surface absolute inset-0 z-20 overflow-y-auto overscroll-contain px-3 pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] sm:px-6 sm:pt-6">
          {!isTie && (didViewerWin || (!viewerTeam && Boolean(spectatorWinner))) ? <CelebrationSparks /> : null}
          <div className="relative z-10 mx-auto w-full max-w-4xl pb-4">
            <header className="flex items-center justify-between gap-4 px-1 text-[#304349]">
              <div className="min-w-0">
                <p className="truncate font-['IBM_Plex_Mono',monospace] text-[10px] font-semibold uppercase tracking-[0.3em] text-[#7c683c]">Final score screen</p>
                <p className="mt-1 truncate font-[Georgia,Times_New_Roman,serif] text-lg font-semibold">{game.name}</p>
              </div>
              {onLeave ? <button className="border-b border-[#6f644c] px-1 py-1 font-['IBM_Plex_Mono',monospace] text-[10px] font-bold uppercase tracking-[0.13em] text-[#43545a]" onClick={onLeave} type="button">Back to lobby</button> : null}
            </header>

            <article className="results-paper relative mt-3 overflow-hidden px-4 py-6 text-[#293a3f] sm:mt-5 sm:px-8 sm:py-8">
              <CartographicRoute />
              <CompassRose />
              <div className="relative z-10">
                <div className="mx-auto max-w-2xl text-center">
                  <p className="font-['IBM_Plex_Mono',monospace] text-[10px] font-semibold uppercase tracking-[0.34em] text-[#8d7138]">Game complete</p>
                  <h1 className="mt-2 font-[Georgia,Times_New_Roman,serif] text-4xl font-semibold leading-none text-[#26373c] sm:text-6xl">{title}</h1>
                  <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[#58666a] sm:text-base">{subtitle}</p>
                </div>

                {scoreboard[0] ? (
                  <div className="results-winner-stamp mx-auto mt-6 flex min-h-44 w-full max-w-sm flex-col items-center justify-center px-6 py-5 text-center" style={{ '--winner-color': scoreboard[0].team.color } as CSSProperties}>
                    <span className="text-2xl text-[#8d7138]" aria-hidden="true">✦</span>
                    <p className="mt-1 font-['IBM_Plex_Mono',monospace] text-[9px] font-bold uppercase tracking-[0.28em] text-[#7d6738]">{isTie ? 'First-place tie' : 'Winner'}</p>
                    <h2 className="mt-2 max-w-full font-[Georgia,Times_New_Roman,serif] text-3xl font-semibold leading-tight text-[#203239] sm:text-4xl">{isTie ? scoreboard.filter((entry) => entry.rank === 1).map((entry) => entry.team.name).join(' · ') : scoreboard[0].team.name}</h2>
                    <p className="mt-2 font-['IBM_Plex_Mono',monospace] text-[10px] uppercase tracking-[0.16em] text-[#667277]">{highestZoneCount} {highestZoneCount === 1 ? 'zone' : 'zones'} held</p>
                  </div>
                ) : (
                  <div className="mx-auto mt-6 max-w-sm border-y border-dashed border-[#9e8b62]/55 py-8 text-center text-sm text-[#687579]">No teams reached the final standings.</div>
                )}

                <section className="mx-auto mt-7 max-w-2xl">
                  <div className="flex items-end justify-between gap-3 border-b border-[#8c7a54]/55 pb-2">
                    <div>
                      <p className="font-['IBM_Plex_Mono',monospace] text-[9px] font-bold uppercase tracking-[0.28em] text-[#866d37]">Score</p>
                      <h2 className="mt-1 font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold text-[#293a3f]">Final standings</h2>
                    </div>
                    <span className="font-['IBM_Plex_Mono',monospace] text-[9px] uppercase tracking-[0.13em] text-[#758085]">Zones held</span>
                  </div>
                  <div className="divide-y divide-dashed divide-[#a99a78]/55">
                    {scoreboard.map((entry) => (
                      <div className={['grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2.5 px-1 py-3', entry.team.id === viewerTeam?.id ? 'bg-[#eadfbe]/55' : ''].join(' ')} key={entry.team.id}>
                        <span className="font-[Georgia,Times_New_Roman,serif] text-xl font-bold text-[#856d3b]">{entry.rank}</span>
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="h-3 w-3 shrink-0 rotate-45 border border-[#f7efd9] shadow-sm" style={{ backgroundColor: entry.team.color }} />
                          <span className="truncate font-[Georgia,Times_New_Roman,serif] text-base font-semibold text-[#26383e]">{entry.team.name}</span>
                          {entry.team.id === viewerTeam?.id ? <span className="hidden font-['IBM_Plex_Mono',monospace] text-[8px] uppercase tracking-[0.12em] text-[#806a3b] sm:inline">Your team</span> : null}
                        </div>
                        <span className="font-['IBM_Plex_Mono',monospace] text-sm font-bold text-[#26383e]">{entry.zoneCount}</span>
                      </div>
                    ))}
                  </div>
                </section>

                <div className="mx-auto mt-7 grid max-w-2xl gap-3 border-t border-dashed border-[#9e8b62]/55 pt-5 sm:grid-cols-2">
                  <button className="group border border-[#2d4147] bg-[#2d4147] px-5 py-4 text-left text-[#f4ead2] shadow-[3px_4px_0_rgba(126,101,54,0.28)] transition hover:-translate-y-0.5" onClick={() => setView('map')} type="button">
                    <span className="block font-['IBM_Plex_Mono',monospace] text-[9px] font-bold uppercase tracking-[0.24em] text-[#d9bd7d]">Replay</span>
                    <span className="mt-1 block font-[Georgia,Times_New_Roman,serif] text-xl font-semibold">Map replay <span aria-hidden="true">↗</span></span>
                    <span className="mt-1 block text-xs leading-5 text-[#e8dfca]/68">Watch the team trails and zone ownership change over time.</span>
                  </button>
                  <button className="border border-[#897650] bg-[#eee2c6]/65 px-5 py-4 text-left text-[#2d4046] shadow-[3px_4px_0_rgba(126,101,54,0.16)] transition hover:-translate-y-0.5 hover:bg-[#f3e8cf]" onClick={() => setShowFeed(true)} type="button">
                    <span className="block font-['IBM_Plex_Mono',monospace] text-[9px] font-bold uppercase tracking-[0.24em] text-[#806938]">Timeline</span>
                    <span className="mt-1 block font-[Georgia,Times_New_Roman,serif] text-xl font-semibold">Read full timeline <span aria-hidden="true">→</span></span>
                    <span className="mt-1 block text-xs leading-5 text-[#617075]">Claims, captures, rerolls, pauses, and every turn of the game.</span>
                  </button>
                </div>
                {recapError ? <p className="mx-auto mt-4 max-w-2xl text-center text-xs text-[#8b4e42]">{recapError}</p> : null}
              </div>
            </article>
          </div>
        </section>
      )}

      {showFeed ? <FeedOverlay entries={buildFeedEntriesForTeams(recap?.events ?? [], teams)} errorMessage={recapError} isLoading={!recap && !recapError} onClose={() => setShowFeed(false)} onFocusZone={() => { setShowFeed(false); setView('map'); }} /> : null}
    </main>
  );
}

function CartographicRoute() {
  return (
    <svg aria-hidden="true" className="results-cartographic-route" preserveAspectRatio="none" viewBox="0 0 800 360">
      <path d="M-40 296 C90 190 168 330 282 218 S468 92 552 162 S686 244 850 66" fill="none" stroke="currentColor" strokeDasharray="5 11" strokeLinecap="round" strokeWidth="2" />
      <circle cx="282" cy="218" fill="currentColor" r="5" />
      <circle cx="552" cy="162" fill="#f2e5c8" r="7" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function CompassRose() {
  return (
    <div aria-hidden="true" className="results-compass-rose">
      <span className="results-compass-north">N</span>
      <span className="results-compass-star">✦</span>
    </div>
  );
}

function ResultsMap({ progress, recap, teams, zones }: { progress: number; recap: GameRecap | null; teams: Team[]; zones: Zone[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRefs = useRef<Map<string, mapboxgl.Marker>>(new Map());
  const [mapReady, setMapReady] = useState(false);
  const teamColorById = useMemo(() => new Map(teams.map((team) => [team.id, team.color])), [teams]);
  const zoneData = useMemo(() => buildZoneData(zones, recap, progress, teamColorById), [progress, recap, teamColorById, zones]);
  const zoneDataRef = useRef(zoneData);
  zoneDataRef.current = zoneData;

  useEffect(() => {
    if (!containerRef.current || !mapboxToken || mapRef.current) return;
    mapboxgl.accessToken = mapboxToken;
    const map = new mapboxgl.Map({ container: containerRef.current, style: 'mapbox://styles/saamoz/cmng3j80c004001s831aw5e3b', attributionControl: false, interactive: true, pitchWithRotate: false, performanceMetricsCollection: false });
    mapRef.current = map;
    map.on('load', () => {
      map.addSource('result-zones', { type: 'geojson', data: zoneDataRef.current });
      map.addLayer({ id: 'result-zone-fill', type: 'fill', source: 'result-zones', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'owned'], 0.4, 0.1] } });
      map.addLayer({ id: 'result-zone-line', type: 'line', source: 'result-zones', paint: { 'line-color': ['get', 'color'], 'line-width': 2.2, 'line-opacity': 0.9 } });
      map.addSource('result-paths', { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer({ id: 'result-path-glow', type: 'line', source: 'result-paths', paint: { 'line-color': ['get', 'color'], 'line-width': 8, 'line-opacity': 0.18 } });
      map.addLayer({ id: 'result-path-line', type: 'line', source: 'result-paths', paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': 0.95 } });
      const positions = zones.flatMap((zone) => collectGeometryPositions(buildRenderedZoneGeometry(zone)));
      if (positions.length) {
        const bounds = positions.slice(1).reduce((value, point) => value.extend(point), new mapboxgl.LngLatBounds(positions[0], positions[0]));
        map.fitBounds(bounds, { padding: 42, duration: 0 });
      }
      setMapReady(true);
    });
    return () => {
      for (const marker of markerRefs.current.values()) marker.remove();
      markerRefs.current.clear();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map?.isStyleLoaded()) return;
    (map.getSource('result-zones') as mapboxgl.GeoJSONSource | undefined)?.setData(zoneData);
    (map.getSource('result-paths') as mapboxgl.GeoJSONSource | undefined)?.setData(buildVisiblePaths(recap?.paths ?? [], progress, teamColorById));
    const visibleTeams = new Set<string>();
    for (const path of recap?.paths ?? []) {
      const point = interpolatePathPoint(path, progress);
      if (!point) continue;
      visibleTeams.add(path.teamId);
      let marker = markerRefs.current.get(path.teamId);
      if (!marker) {
        const element = document.createElement('div');
        element.className = 'result-team-marker';
        element.style.backgroundColor = teamColorById.get(path.teamId) ?? '#d7bb78';
        marker = new mapboxgl.Marker({ element }).setLngLat([point.lng, point.lat]).addTo(map);
        markerRefs.current.set(path.teamId, marker);
      } else marker.setLngLat([point.lng, point.lat]);
    }
    for (const [teamId, marker] of markerRefs.current) {
      if (!visibleTeams.has(teamId)) { marker.remove(); markerRefs.current.delete(teamId); }
    }
  }, [progress, recap, teamColorById, zoneData, mapReady]);

  return <div className="absolute inset-0" ref={containerRef} />;
}

function buildZoneData(zones: Zone[], recap: GameRecap | null, progress: number, colors: Map<string, string>): GeoJSON.FeatureCollection {
  const ownerByZoneId = new Map<string, string>();
  if (recap) {
    for (const moment of recap.moments) {
      if (moment.progress > progress) break;
      if (moment.type === 'challenge_completed' && moment.zoneId && moment.teamId) ownerByZoneId.set(moment.zoneId, moment.teamId);
    }
  }
  return {
    type: 'FeatureCollection',
    features: zones.map((zone) => {
      const ownerTeamId = recap ? ownerByZoneId.get(zone.id) ?? (progress >= 0.999 ? zone.ownerTeamId : null) : zone.ownerTeamId;
      return { type: 'Feature', id: zone.id, properties: { color: ownerTeamId ? colors.get(ownerTeamId) ?? '#b9aa85' : '#8a928f', owned: Boolean(ownerTeamId) }, geometry: buildRenderedZoneGeometry(zone) } as GeoJSON.Feature;
    }),
  };
}

function buildVisiblePaths(paths: TeamRecapPath[], progress: number, colors: Map<string, string>): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: paths.flatMap((path): GeoJSON.Feature[] => {
      const coordinates = path.points.filter((point) => point.progress <= progress).map((point) => [point.lng, point.lat]);
      const current = interpolatePathPoint(path, progress);
      if (current && coordinates.length) coordinates.push([current.lng, current.lat]);
      return coordinates.length >= 2 ? [{ type: 'Feature', properties: { teamId: path.teamId, color: colors.get(path.teamId) ?? '#d7bb78' }, geometry: { type: 'LineString', coordinates } }] : [];
    }),
  };
}

function interpolatePathPoint(path: TeamRecapPath, progress: number) {
  if (!path.points.length || progress < path.points[0]!.progress) return null;
  const nextIndex = path.points.findIndex((point) => point.progress > progress);
  if (nextIndex < 0) return path.points[path.points.length - 1]!;
  const next = path.points[nextIndex]!;
  const previous = path.points[Math.max(0, nextIndex - 1)]!;
  const amount = (progress - previous.progress) / Math.max(0.000001, next.progress - previous.progress);
  return { lng: previous.lng + (next.lng - previous.lng) * amount, lat: previous.lat + (next.lat - previous.lat) * amount };
}

function emptyFeatureCollection(): GeoJSON.FeatureCollection { return { type: 'FeatureCollection', features: [] }; }
function findActiveMoment(recap: GameRecap, progress: number): GameRecapMoment | null { return [...recap.moments].reverse().find((moment) => moment.progress <= progress && progress - moment.progress < 0.045) ?? null; }
function colorForTeam(teamId: string | null, teams: Team[]) { return teams.find((team) => team.id === teamId)?.color ?? '#e0bd6d'; }
function withTiedRanks<T extends { zoneCount: number; rank: number }>(entries: T[]): T[] { let rank = 0; let previousScore: number | null = null; return entries.map((entry, index) => { if (previousScore === null || entry.zoneCount !== previousScore) rank = index + 1; previousScore = entry.zoneCount; return { ...entry, rank }; }); }
function ordinal(value: number) { const remainder = value % 100; if (remainder >= 11 && remainder <= 13) return `${value}th`; return `${value}${value % 10 === 1 ? 'st' : value % 10 === 2 ? 'nd' : value % 10 === 3 ? 'rd' : 'th'}`; }
function formatReplayTime(recap: GameRecap | null, progress: number) { if (!recap) return 'Final map'; const start = new Date(recap.startedAt).getTime(); const end = new Date(recap.endedAt).getTime(); return new Date(start + (end - start) * progress).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function CelebrationSparks() { return <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-20 h-52 overflow-hidden">{Array.from({ length: 18 }, (_, index) => <span className="result-spark" key={index} style={{ left: `${4 + ((index * 31) % 92)}%`, animationDelay: `${(index % 6) * 0.13}s`, backgroundColor: index % 3 === 0 ? '#e9c66f' : index % 3 === 1 ? '#f5ead1' : '#cf7f67' }} />)}</div>; }
