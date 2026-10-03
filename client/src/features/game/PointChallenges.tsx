import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { DEFAULT_POINT_CHALLENGE_RADIUS_METERS, getBasePoints, getChallengeBonuses, isJudgedChallengeConfig, type Challenge, type GeoJsonPoint } from '@city-game/shared';
import { BonusChecklist, BonusList, PointsTotal, ScoreChips, formatPoints, useBonusSelection, type CompletionExtras } from './ChallengeScoring';
import { isAreaChallenge, isInsideArea } from './ChallengeAreas';
import { JudgedMark } from './JudgedChallenges';
import type { GeolocationStatus } from './useGeolocation';

export function getPointLocation(challenge: Challenge): GeoJsonPoint | null {
  const value = challenge.config?.source_map_point as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const point = value as GeoJsonPoint;
  return point.type === 'Point' && Array.isArray(point.coordinates) && typeof point.coordinates[0] === 'number' && typeof point.coordinates[1] === 'number' ? point : null;
}

export function isPointChallenge(challenge: Challenge): boolean { return getPointLocation(challenge) !== null; }

export function getPointRadius(challenge: Challenge): number {
  const value = challenge.config?.point_radius_meters;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_POINT_CHALLENGE_RADIUS_METERS;
}

interface LayerProps { map: mapboxgl.Map | null; challenges: Challenge[]; selectedId: string | null; onSelect(id: string): void }

export function PointChallengeLayer({ map, challenges, selectedId, onSelect }: LayerProps) {
  const markers = useRef(new Map<string, mapboxgl.Marker>());
  useEffect(() => {
    if (!map) return;
    const visible = challenges.filter((c) => c.status === 'available' && getPointLocation(c));
    const ids = new Set(visible.map((c) => c.id));
    for (const [id, marker] of markers.current) if (!ids.has(id)) { marker.remove(); markers.current.delete(id); }
    for (const challenge of visible) {
      const point = getPointLocation(challenge)!;
      let marker = markers.current.get(challenge.id);
      if (!marker) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'point-challenge-marker';
        button.setAttribute('aria-label', challenge.title);
        const judged = isJudgedChallengeConfig(challenge.config);
        button.innerHTML = '<span class="point-challenge-marker__pulse"></span><span class="point-challenge-marker__pin"><span>' + (judged ? '★' : '!') + '</span></span>';
        button.addEventListener('click', (event) => { event.stopPropagation(); onSelect(challenge.id); });
        marker = new mapboxgl.Marker({ element: button, anchor: 'bottom' }).setLngLat([point.coordinates[0] as number, point.coordinates[1] as number]).addTo(map);
        markers.current.set(challenge.id, marker);
      }
      marker.getElement().classList.toggle('is-selected', challenge.id === selectedId);
    }
    return () => {};
  }, [map, challenges, selectedId, onSelect]);
  useEffect(() => () => { for (const marker of markers.current.values()) marker.remove(); markers.current.clear(); }, []);
  return null;
}

interface CardProps {
  challenge: Challenge; distanceMeters: number | null; locationStatus: GeolocationStatus;
  pending: boolean; onClose(): void; onComplete(extras?: CompletionExtras): void;
}

export function PointChallengeCard({ challenge, distanceMeters, locationStatus, pending, onClose, onComplete }: CardProps) {
  const judged = isJudgedChallengeConfig(challenge.config);
  const isArea = isAreaChallenge(challenge);
  const radius = getPointRadius(challenge);
  const inRange = isArea ? isInsideArea(distanceMeters) : distanceMeters !== null && distanceMeters <= radius;
  const short = typeof challenge.config?.short_description === 'string' ? challenge.config.short_description : challenge.description;
  const base = getBasePoints(challenge.scoring);
  const bonuses = getChallengeBonuses(challenge.config);
  const { selected, toggle } = useBonusSelection();
  const total = base + bonuses.filter((bonus) => selected.has(bonus.id)).reduce((sum, bonus) => sum + bonus.points, 0);
  return <div className="pointer-events-auto absolute inset-x-4 bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] z-30 mx-auto max-w-md">
    <article className="overflow-hidden rounded-[1.75rem] border border-[#c9ae6d]/70 bg-[#fff8eb]/97 shadow-[0_24px_80px_rgba(25,35,40,.28)] backdrop-blur-xl">
      <div className="h-1.5 bg-gradient-to-r from-[#d97a37] via-[#c9ae6d] to-[#647d74]" />
      <div className="max-h-[72dvh] overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-4">
          <div><p className="flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-[.28em] text-[#936718]">{isArea ? 'Area challenge' : 'On-location challenge'}{judged ? <JudgedMark challenge={challenge} /> : null}</p>
          <h2 className="mt-2 font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold leading-tight text-[#1f2a2f]">{challenge.title}</h2>
          <div className="mt-2"><ScoreChips challenge={challenge} /></div></div>
          <button className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eee4cf] text-lg text-[#44545c]" onClick={onClose} aria-label="Close" type="button">x</button>
        </div>
        <p className="mt-3 text-sm leading-6 text-[#526269]">{short}</p>
        <div className="mt-4 flex items-center justify-between rounded-2xl border border-[#d8c8a3]/60 bg-[#f3ecd8] px-4 py-3">
          <span className="text-xs font-semibold uppercase tracking-[.15em] text-[#6f6249]">{isArea ? 'Anywhere in the shaded area' : 'Arrival radius ' + Math.round(radius) + ' m'}</span>
          <span className={inRange ? 'text-sm font-bold text-[#39705d]' : 'text-sm font-semibold text-[#8a5c2e]'}>
            {distanceMeters === null ? 'Locating...' : inRange ? (isArea ? "You're in it" : 'You are here') : Math.round(distanceMeters) + ' m away'}
          </span>
        </div>
        {bonuses.length ? (
          <div className="mt-4 space-y-2">
            <BonusChecklist bonuses={bonuses} onToggle={toggle} selected={selected} />
            <PointsTotal base={base} bonuses={bonuses} selected={selected} />
          </div>
        ) : null}
        <button className="mt-4 w-full rounded-2xl border border-[#29414b] bg-[#24343a] px-4 py-3.5 text-sm font-semibold uppercase tracking-[.13em] text-[#f4ead7] transition hover:bg-[#1d2b30] disabled:cursor-not-allowed disabled:bg-[#9aa7aa]"
          disabled={!inRange || pending || locationStatus === 'requesting' || locationStatus === 'unsupported'} onClick={() => onComplete({ bonusIds: [...selected] })} type="button">
          {pending ? 'Completing...' : inRange ? 'Complete · ' + formatPoints(total) : 'Get closer to unlock'}
        </button>
        {judged ? <p className="mt-2 text-center text-[11px] text-[#6b777b]">Judged: points are awarded after the game.</p> : null}
      </div>
    </article>
  </div>;
}
