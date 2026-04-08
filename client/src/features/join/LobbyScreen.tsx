import { useEffect, useMemo, useRef } from 'react';
import type { Game, MapDefinition, MapZone, Player, Team } from '@city-game/shared';
import { collectGeometryPositions } from '../game/mapGeometry';

interface LobbyScreenProps {
  game: Game;
  teams: Team[];
  players: Player[];
  player: Player;
  mapDefinition: MapDefinition | null;
  mapZones: MapZone[];
  connectionMessage: string | null;
  onLeaveTeam(): void;
  isLeavingTeam: boolean;
  canShowNotificationPrompt: boolean;
  notificationPromptMessage: string | null;
  notificationPromptPending: boolean;
  onEnableNotifications(): void;
  onDismissNotifications(): void;
}

const mapboxToken = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? import.meta.env.MAPBOX_ACCESS_TOKEN ?? '').trim();

export function LobbyScreen({
  game,
  teams,
  players,
  player,
  mapDefinition,
  mapZones,
  connectionMessage,
  onLeaveTeam,
  isLeavingTeam,
  canShowNotificationPrompt,
  notificationPromptMessage,
  notificationPromptPending,
  onEnableNotifications,
  onDismissNotifications,
}: LobbyScreenProps) {
  const playersByTeamId = useMemo(() => {
    const roster = new Map<string, Player[]>();
    for (const team of teams) {
      roster.set(team.id, []);
    }
    for (const entry of players) {
      if (!entry.teamId) {
        continue;
      }
      const teamPlayers = roster.get(entry.teamId) ?? [];
      teamPlayers.push(entry);
      roster.set(entry.teamId, teamPlayers);
    }
    return roster;
  }, [players, teams]);

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#f5f0e8] text-[#223238]">
      <LobbyMapBackground game={game} mapDefinition={mapDefinition} mapZones={mapZones} />
      <div className="absolute inset-0 bg-[rgba(245,240,232,0.72)]" />

      <div className="relative z-10 flex min-h-screen items-center justify-center px-4 py-6 sm:px-6 lg:px-8">
        <section className="max-h-[calc(100vh-3rem)] w-full max-w-5xl overflow-y-auto rounded-[2rem] border border-[#d2c19d]/70 bg-[#f0ebe0]/95 px-5 py-6 shadow-[0_28px_80px_rgba(31,42,47,0.18)] backdrop-blur sm:px-8 sm:py-8">
          <header className="text-center">
            <div className="flex items-center justify-between gap-3">
              <div className="w-20" />
              <div className="flex-1" />
              <button
                className="w-20 rounded-full border border-[#d8c6a0]/70 bg-[#fbf6ea] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#5a676c] transition hover:bg-[#fffaf0] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isLeavingTeam}
                onClick={onLeaveTeam}
                type="button"
              >
                {isLeavingTeam ? 'Leaving…' : 'Leave'}
              </button>
            </div>
            <p className="text-[11px] uppercase tracking-[0.34em] text-[#8c7a57]">Pre-Game Lobby</p>
            <h1 className="mt-4 font-[Georgia,Times_New_Roman,serif] text-3xl font-semibold text-[#223238] sm:text-4xl">
              {game.name}
            </h1>
            <div className="mt-4 inline-flex items-center gap-3 rounded-full border border-[#d8c6a0]/70 bg-[#fbf6ea] px-4 py-2 text-sm text-[#4d5c61]">
              <span className="h-2.5 w-2.5 rounded-full bg-[#c8a86b] animate-pulse" />
              <span className="font-[Georgia,Times_New_Roman,serif]">Waiting for the game to start…</span>
            </div>
            {connectionMessage ? (
              <p className="mt-3 text-xs uppercase tracking-[0.2em] text-[#7e7258]">{connectionMessage}</p>
            ) : null}
            {canShowNotificationPrompt ? (
              <div className="mx-auto mt-5 max-w-2xl rounded-[1.4rem] border border-[#d2c19d]/70 bg-[#fbf6ea]/96 px-4 py-4 text-left shadow-[0_16px_34px_rgba(31,42,47,0.08)] sm:px-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.24em] text-[#8c7a57]">Zone Alerts</p>
                    <p className="mt-1 text-sm leading-6 text-[#44545b]">Get notified when rival teams capture a zone.</p>
                    {notificationPromptMessage ? (
                      <p className="mt-2 text-sm text-[#8a5a42]">{notificationPromptMessage}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      className="rounded-full bg-[#c8a86b] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#1f2a2f] transition hover:bg-[#d3b57c] disabled:cursor-not-allowed disabled:bg-[#d8ceb9] disabled:text-[#867c69]"
                      disabled={notificationPromptPending}
                      onClick={onEnableNotifications}
                      type="button"
                    >
                      {notificationPromptPending ? 'Enabling…' : 'Enable'}
                    </button>
                    <button
                      className="rounded-full border border-[#d2c19d]/70 bg-transparent px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#5a676c] transition hover:bg-[#f5ecdb]"
                      disabled={notificationPromptPending}
                      onClick={onDismissNotifications}
                      type="button"
                    >
                      Not now
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </header>

          <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {teams.map((team) => {
              const roster = playersByTeamId.get(team.id) ?? [];
              return (
                <article
                  key={team.id}
                  className="rounded-[1.4rem] border border-[#d7c8a7]/65 bg-[#fbf6ea]/96 px-5 py-4 shadow-[0_14px_34px_rgba(31,42,47,0.08)]"
                >
                  <div className="flex items-center gap-3">
                    <span className="h-3.5 w-3.5 rounded-full border border-[#f8f1df]" style={{ backgroundColor: team.color }} />
                    <h2 className="font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold text-[#223238]">{team.name}</h2>
                  </div>
                  <div className="mt-4 space-y-2.5 text-sm text-[#405159]">
                    {roster.length ? roster.map((entry) => {
                      const isCurrentPlayer = entry.id === player.id;
                      return (
                        <div key={entry.id} className="flex items-center justify-between gap-3 rounded-full bg-[#f3ecd8] px-3 py-2">
                          <span className={isCurrentPlayer ? 'font-semibold' : ''} style={isCurrentPlayer ? { color: team.color } : undefined}>
                            {entry.displayName}
                          </span>
                          {isCurrentPlayer ? (
                            <span className="rounded-full border border-[#d3c099] bg-[#fff9ee] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[#6f6045]">
                              You
                            </span>
                          ) : null}
                        </div>
                      );
                    }) : (
                      <p className="italic text-[#83765f]">No players yet</p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}

function LobbyMapBackground({ game, mapDefinition, mapZones }: { game: Game; mapDefinition: MapDefinition | null; mapZones: MapZone[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const fitDoneRef = useRef(false);
  const sourceData = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: mapZones.map((zone) => ({
      type: 'Feature',
      id: zone.id,
      properties: {
        name: zone.name,
      },
      geometry: zone.geometry,
    })),
  }), [mapZones]);

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
        center: [mapDefinition?.centerLng ?? game.centerLng, mapDefinition?.centerLat ?? game.centerLat],
        zoom: mapDefinition?.defaultZoom ?? game.defaultZoom,
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

        if (!map.getSource('lobby-zones')) {
          map.addSource('lobby-zones', {
            type: 'geojson',
            data: sourceData as any,
          });
        }

        map.addLayer({
          id: 'lobby-zones-fill',
          type: 'fill',
          source: 'lobby-zones',
          paint: {
            'fill-color': '#b7b1a2',
            'fill-opacity': 0.18,
          },
        });

        map.addLayer({
          id: 'lobby-zones-line',
          type: 'line',
          source: 'lobby-zones',
          paint: {
            'line-color': '#756e61',
            'line-opacity': 0.38,
            'line-width': 1.25,
          },
        });
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
  }, [game.centerLat, game.centerLng, game.defaultZoom, mapDefinition?.centerLat, mapDefinition?.centerLng, mapDefinition?.defaultZoom, sourceData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const source = map.getSource('lobby-zones');
    if (source && 'setData' in source) {
      source.setData(sourceData);
    }
  }, [sourceData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || fitDoneRef.current || !mapZones.length) {
      return;
    }

    const positions = mapZones.flatMap((zone) => collectGeometryPositions(zone.geometry));
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
  }, [mapZones]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
