import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { GeoJsonGeometry, GameStateSnapshot } from '@city-game/shared';
import { ApiError, getMapState } from '../../lib/api';
import { navigateToLanding } from '../../lib/routing';
import { useGameStore } from '../../store/gameStore';
import { ZoneLayer } from './ZoneLayer';

interface GameViewProps {
  gameId: string;
}

const mapboxToken = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? import.meta.env.MAPBOX_ACCESS_TOKEN ?? '').trim();

export function GameView({ gameId }: GameViewProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const didFitBoundsRef = useRef(false);
  const { snapshot, status, errorMessage, setLoading, initializeSnapshot, setError, reset } = useGameStore();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(gameId);

    void getMapState(gameId, controller.signal)
      .then((nextSnapshot) => {
        initializeSnapshot(gameId, nextSnapshot);
      })
      .catch((error) => {
        setError(gameId, getGameViewError(error));
      });

    return () => {
      controller.abort();
      reset();
    };
  }, [gameId, initializeSnapshot, reset, setError, setLoading]);

  useEffect(() => {
    if (!snapshot || !mapContainerRef.current || !mapboxToken || mapRef.current) {
      return;
    }

    mapboxgl.accessToken = mapboxToken;
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [snapshot.game.centerLng, snapshot.game.centerLat],
      zoom: snapshot.game.defaultZoom,
      pitchWithRotate: false,
      attributionControl: false,
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      didFitBoundsRef.current = false;
    };
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot || !mapRef.current || didFitBoundsRef.current) {
      return;
    }

    const bounds = getBoundsFromSnapshot(snapshot);
    if (bounds) {
      mapRef.current.fitBounds(bounds, {
        padding: 64,
        duration: 0,
      });
    }

    didFitBoundsRef.current = true;
  }, [snapshot]);

  const missingToken = mapboxToken.length === 0;
  const team = snapshot?.team ?? null;

  return (
    <main className="relative h-screen overflow-hidden bg-slate-950 text-white">
      <div ref={mapContainerRef} className="absolute inset-0" />
      <ZoneLayer map={mapRef.current} snapshot={snapshot} />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-[linear-gradient(180deg,rgba(3,7,18,0.88),rgba(3,7,18,0))] px-4 pb-8 pt-4 sm:px-6 lg:px-8">
        <div className="pointer-events-auto mx-auto flex max-w-7xl flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="rounded-3xl border border-white/10 bg-slate-950/75 px-5 py-4 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur">
            <p className="text-[11px] uppercase tracking-[0.35em] text-cyan-200/80">Live Map</p>
            <h1 className="mt-2 font-['Space_Grotesk',system-ui,sans-serif] text-2xl font-semibold text-white">
              {snapshot?.game.name ?? 'Loading game'}
            </h1>
            <p className="mt-1 text-sm text-slate-300">
              {snapshot?.player?.displayName ?? 'Checking session'}
              {team ? ` · ${team.name}` : ''}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <StatusCard label="Teams" value={String(snapshot?.teams.length ?? 0)} />
            <StatusCard label="Zones" value={String(snapshot?.zones.length ?? 0)} />
            <StatusCard label="Version" value={String(snapshot?.game.stateVersion ?? 0)} />
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-4 sm:px-6 lg:px-8">
        <div className="pointer-events-auto mx-auto max-w-7xl rounded-[1.75rem] border border-white/10 bg-slate-950/78 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur">
          {missingToken ? (
            <Banner title="Mapbox token required" body="Add VITE_MAPBOX_ACCESS_TOKEN to the root .env file, then restart the client." tone="warning" />
          ) : null}

          {status === 'loading' ? (
            <Banner title="Loading map state" body="Fetching the authoritative snapshot from /game/:id/map-state." />
          ) : null}

          {status === 'error' ? (
            <Banner title="Unable to load map state" body={errorMessage ?? 'The snapshot request failed.'} tone="danger" />
          ) : null}

          {snapshot ? (
            <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-slate-400">Zone ownership</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {snapshot.teams.map((entry) => (
                    <div key={entry.id} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                      <span>{entry.name}</span>
                    </div>
                  ))}
                  {!snapshot.teams.length ? (
                    <span className="text-sm text-slate-400">No teams configured yet.</span>
                  ) : null}
                </div>
              </div>

              <button
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-slate-100 transition hover:bg-white/10"
                onClick={navigateToLanding}
                type="button"
              >
                Leave Map
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-3xl border border-white/10 bg-slate-950/75 px-4 py-3 text-right shadow-[0_20px_60px_rgba(0,0,0,0.28)] backdrop-blur">
      <p className="text-[11px] uppercase tracking-[0.28em] text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
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
    ? 'border-rose-400/20 bg-rose-400/10 text-rose-100'
    : tone === 'warning'
      ? 'border-amber-300/20 bg-amber-300/10 text-amber-50'
      : 'border-cyan-300/20 bg-cyan-300/10 text-cyan-50';

  return (
    <div className={`rounded-2xl border px-4 py-3 ${toneClassName}`}>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-sm text-slate-200">{body}</p>
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
  const positions = snapshot.zones.flatMap((zone) => collectPositions(zone.geometry));

  if (!positions.length) {
    return null;
  }

  const bounds = new mapboxgl.LngLatBounds(positions[0], positions[0]);
  for (const position of positions.slice(1)) {
    bounds.extend(position);
  }

  return bounds;
}

function collectPositions(geometry: GeoJsonGeometry): Array<[number, number]> {
  switch (geometry.type) {
    case 'Point':
      return [[geometry.coordinates[0], geometry.coordinates[1]]];
    case 'LineString':
      return geometry.coordinates.map((position) => [position[0], position[1]] as [number, number]);
    case 'Polygon':
      return geometry.coordinates.flat().map((position) => [position[0], position[1]] as [number, number]);
    case 'MultiPolygon':
      return geometry.coordinates.flat(2).map((position) => [position[0], position[1]] as [number, number]);
  }
}
