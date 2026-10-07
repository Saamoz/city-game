import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { DEFAULT_POINT_CHALLENGE_RADIUS_METERS, type Challenge, type GeoJsonPoint } from '@city-game/shared';
import { getAreaCenter, isAreaChallenge } from './ChallengeAreas';

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

const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5 14.2 9.8 22.5 12 14.2 14.2 12 22.5 9.8 14.2 1.5 12 9.8 9.8Z"/></svg>';
const AREA_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" class="is-area"><path d="M4 6.5 18.5 3.5 20.5 17 6 20.5Z" fill="none" stroke-width="1.8" stroke-dasharray="2.6 1.8" stroke-linejoin="round"/><path d="M8 16.5 15.5 7.5M6.8 12.5 11.5 7M11.5 17.5 17.5 10.5" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>';

// Card markers for every challenge on the map: pinned ones stand on an ink stem whose dot marks the
// exact spot; area ones sit flat at the area's centre (no stem), alongside the shaded area itself.
export function PointChallengeLayer({ map, challenges, selectedId, onSelect }: LayerProps) {
  const markers = useRef(new Map<string, mapboxgl.Marker>());
  // Markers outlive renders, so read the latest handler at click time.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  useEffect(() => {
    if (!map) return;
    const visible = challenges.filter((c) => c.status === 'available' && (getPointLocation(c) || isAreaChallenge(c)));
    const ids = new Set(visible.map((c) => c.id));
    for (const [id, marker] of markers.current) if (!ids.has(id)) { marker.remove(); markers.current.delete(id); }
    for (const challenge of visible) {
      const point = getPointLocation(challenge);
      const position = point ? [point.coordinates[0] as number, point.coordinates[1] as number] as [number, number] : getAreaCenter(challenge);
      if (!position) continue;
      let marker = markers.current.get(challenge.id);
      if (!marker) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'point-challenge-marker map-card-marker' + (point ? '' : ' map-card-marker--area');
        button.setAttribute('aria-label', challenge.title);
        button.innerHTML = point
          ? '<span class="map-card-marker__card">' + STAR_SVG + '</span><span class="map-card-marker__stem"></span><span class="map-card-marker__dot"></span>'
          : '<span class="map-card-marker__card">' + AREA_SVG + '</span>';
        button.addEventListener('click', (event) => { event.stopPropagation(); onSelectRef.current(challenge.id); });
        marker = new mapboxgl.Marker({ element: button, anchor: point ? 'bottom' : 'center' }).setLngLat(position).addTo(map);
        markers.current.set(challenge.id, marker);
      }
      marker.getElement().classList.toggle('is-selected', challenge.id === selectedId);
    }
  }, [map, challenges, selectedId]);
  useEffect(() => () => { for (const marker of markers.current.values()) marker.remove(); markers.current.clear(); }, []);
  return null;
}
