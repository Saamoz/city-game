import { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import type { GameRecap, GameRecapMoment, GameStateSnapshot, Team, TeamRecapPath, Zone } from '@city-game/shared';
import { getGameRecap } from '../../lib/api';
import { FeedOverlay, buildFeedEntries, buildZoneScoreboard } from './Phase32Panels';
import { buildRenderedZoneGeometry, collectGeometryPositions } from './mapGeometry';

interface GameResultsScreenProps {
  snapshot: GameStateSnapshot;
  onLeave(): void;
}

type ResultsView = 'results' | 'map';

const mapboxToken = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? import.meta.env.MAPBOX_ACCESS_TOKEN ?? '').trim();

export function GameResultsScreen({ snapshot, onLeave }: GameResultsScreenProps) {
  const [recap, setRecap] = useState<GameRecap | null>(null);
  const [recapError, setRecapError] = useState<string | null>(null);
  const [progress, setProgress] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [view, setView] = useState<ResultsView>('results');
  const [showFeed, setShowFeed] = useState(false);
  const startedPlaybackAtRef = useRef(0);
  const startedProgressRef = useRef(0);
  const scoreboard = useMemo(() => withTiedRanks(buildZoneScoreboard(snapshot)), [snapshot]);
  const highestZoneCount = scoreboard[0]?.zoneCount ?? 0;
  const winnerIds = useMemo(() => new Set(scoreboard.filter((entry) => entry.zoneCount === highestZoneCount).map((entry) => entry.team.id)), [highestZoneCount, scoreboard]);
  const viewerEntry = scoreboard.find((entry) => entry.team.id === snapshot.team?.id) ?? null;
  const didViewerWin = Boolean(snapshot.team && winnerIds.has(snapshot.team.id));
  const isTie = winnerIds.size > 1;

  useEffect(() => {
    const controller = new AbortController();
    void getGameRecap(snapshot.game.id, controller.signal)
      .then(setRecap)
      .catch(() => setRecapError('The movement replay could not be loaded. Final scores and map are still available.'));
    return () => controller.abort();
  }, [snapshot.game.id]);

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
  const title = snapshot.team ? didViewerWin ? (isTie ? "It's a draw!" : 'Victory!') : 'Game over' : 'Final standings';
  const subtitle = snapshot.team
    ? didViewerWin
      ? isTie
        ? `${snapshot.team.name} tied for first with ${viewerEntry?.zoneCount ?? 0} zones.`
        : `${snapshot.team.name} finished on top with ${viewerEntry?.zoneCount ?? 0} zones.`
      : `${snapshot.team.name} placed ${ordinal(viewerEntry?.rank ?? scoreboard.length)} with ${viewerEntry?.zoneCount ?? 0} zones.`
    : isTie ? `${winnerIds.size} teams tied for first with ${highestZoneCount} zones.` : `${scoreboard[0]?.team.name ?? 'No team'} finished on top with ${highestZoneCount} zones.`;

  return (
    <main className="relative h-[100dvh] overflow-hidden bg-[#17262c] text-[#f8efdd]">
      <ResultsMap progress={progress} recap={recap} teams={snapshot.teams} zones={snapshot.zones} />

      {view === 'map' ? (
        <>
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(12,25,30,0.62),transparent_25%,transparent_62%,rgba(12,25,30,0.55))]" />
          <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 px-4 pt-[calc(env(safe-area-inset-top,0px)+0.8rem)] sm:px-6">
            <div className="min-w-0 rounded-2xl border border-[#ead5a5]/35 bg-[#14252b]/78 px-3.5 py-2.5 shadow-lg backdrop-blur-md">
              <p className="truncate text-[9px] font-semibold uppercase tracking-[0.25em] text-[#e0bd6d]">{snapshot.game.name} · Replay</p>
              <p className="mt-0.5 truncate font-[Georgia,Times_New_Roman,serif] text-lg font-semibold">{title}</p>
            </div>
            <div className="pointer-events-auto flex shrink-0 gap-2">
              <button className="rounded-full border border-[#ead5a5]/40 bg-[#14252b]/82 px-3.5 py-2.5 text-[10px] font-bold uppercase tracking-[0.14em] shadow-lg backdrop-blur-md" onClick={() => setView('results')} type="button">Results</button>
              <button className="rounded-full border border-[#ead5a5]/40 bg-[#14252b]/82 px-3.5 py-2.5 text-[10px] font-bold uppercase tracking-[0.14em] shadow-lg backdrop-blur-md" onClick={onLeave} type="button">Lobby</button>
            </div>
          </header>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.65rem)] sm:px-6 sm:pb-5">
            <section className="pointer-events-auto mx-auto max-w-2xl rounded-[1.35rem] border border-[#d6bb7a]/45 bg-[#17282f]/92 px-3.5 py-3 shadow-[0_18px_50px_rgba(8,16,19,0.42)] backdrop-blur-md sm:px-5">
              {activeMoment ? (
                <div className="mb-2 flex min-w-0 items-center gap-2 border-b border-[#d6bb7a]/20 pb-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorForTeam(activeMoment.teamId, snapshot.teams) }} />
                  <p className="truncate text-xs font-semibold">{activeMoment.title}</p>
                </div>
              ) : recapError ? <p className="mb-2 text-xs text-[#f3c5ba]">{recapError}</p> : null}
              <div className="flex items-center gap-3">
                <button className="shrink-0 rounded-full bg-[#e8c36c] px-3.5 py-2 text-[10px] font-bold uppercase tracking-[0.13em] text-[#1c2c31] disabled:opacity-45" disabled={!recap} onClick={togglePlayback} type="button">
                  {isPlaying ? 'Pause' : progress >= 0.999 ? 'Replay' : 'Play'}
                </button>
                <div className="min-w-0 flex-1">
                  <input aria-label="Replay position" className="block w-full accent-[#e8c36c]" disabled={!recap} max="1000" min="0" onChange={(event) => seek(Number(event.target.value) / 1000)} type="range" value={Math.round(progress * 1000)} />
                  <div className="mt-0.5 flex justify-between text-[9px] uppercase tracking-[0.12em] text-[#f8efdd]/58">
                    <span>{formatReplayTime(recap, progress)}</span>
                    <span>{recap ? `${recap.playbackDurationSeconds}s` : 'Loading'}</span>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </>
      ) : (
        <section className="absolute inset-0 z-20 overflow-y-auto overscroll-contain bg-[radial-gradient(circle_at_15%_10%,rgba(211,170,82,0.17),transparent_30%),linear-gradient(160deg,rgba(19,37,44,0.97),rgba(12,24,29,0.96))] px-4 pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] pt-[calc(env(safe-area-inset-top,0px)+1rem)] sm:px-6">
          {didViewerWin && !isTie ? <CelebrationSparks /> : null}
          <div className="relative z-10 mx-auto flex min-h-full max-w-4xl flex-col justify-between gap-8">
            <header className="flex items-start justify-between gap-4">
              <div className="max-w-2xl">
                <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-[#e0bd6d]">{snapshot.game.name} · Final</p>
                <h1 className="mt-2 font-[Georgia,Times_New_Roman,serif] text-4xl font-semibold leading-none sm:text-6xl">{title}</h1>
                <p className="mt-3 max-w-xl text-sm leading-6 text-[#f8efdd]/78 sm:text-base">{subtitle}</p>
              </div>
              <button className="shrink-0 rounded-full border border-[#ead5a5]/35 bg-[#20353d] px-3.5 py-2 text-[10px] font-bold uppercase tracking-[0.14em]" onClick={onLeave} type="button">Lobby</button>
            </header>

            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
              <button className="group flex min-h-48 flex-col justify-end overflow-hidden rounded-[1.8rem] border border-[#d6bb7a]/45 bg-[linear-gradient(145deg,rgba(224,189,109,0.18),rgba(23,40,47,0.88))] p-5 text-left shadow-[0_24px_70px_rgba(8,16,19,0.35)] transition hover:border-[#e8c36c]/70 hover:bg-[#203740] sm:p-6" onClick={() => setView('map')} type="button">
                <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#e0bd6d]">Interactive final map</span>
                <span className="mt-2 font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold sm:text-3xl">Map & replay →</span>
                <span className="mt-2 max-w-md text-sm leading-6 text-[#f8efdd]/68">Pan around freely, replay every team path, and watch zones change hands as challenges are completed.</span>
              </button>

              <section className="rounded-[1.8rem] border border-[#d6bb7a]/45 bg-[#f5eddc]/96 p-4 text-[#21333a] shadow-[0_24px_70px_rgba(8,16,19,0.35)] sm:p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#966b19]">Final score</p>
                    <h2 className="mt-1 font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold">Zones held</h2>
                  </div>
                  <button className="rounded-full border border-[#bda66f]/55 bg-[#fff9ec] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em]" onClick={() => setShowFeed(true)} type="button">Timeline</button>
                </div>
                <div className="mt-4 space-y-2">
                  {scoreboard.map((entry) => (
                    <div className={['flex items-center justify-between rounded-2xl border px-3 py-2.5', entry.team.id === snapshot.team?.id ? 'border-[#92732f]/55 bg-[#fff9ec]' : 'border-[#d9c9a4]/65 bg-[#eee4ce]'].join(' ')} key={entry.team.id}>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="w-5 text-center text-sm font-bold text-[#8a6b2d]">{entry.rank}</span>
                        <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-white" style={{ backgroundColor: entry.team.color }} />
                        <span className="truncate text-sm font-semibold">{entry.team.name}</span>
                      </div>
                      <span className="ml-3 text-sm font-bold">{entry.zoneCount}</span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </section>
      )}

      {showFeed ? <FeedOverlay entries={buildFeedEntries(recap?.events ?? [], snapshot)} errorMessage={recapError} isLoading={!recap && !recapError} onClose={() => setShowFeed(false)} onFocusZone={() => { setShowFeed(false); setView('map'); }} /> : null}
    </main>
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
