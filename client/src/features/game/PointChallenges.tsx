import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { DEFAULT_POINT_CHALLENGE_RADIUS_METERS, type Challenge, type GeoJsonPoint } from '@city-game/shared';

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
        button.className = 'point-challenge-marker map-card-marker';
        button.setAttribute('aria-label', challenge.title);
        // A small parchment card on an ink stem; the dot marks the exact spot. Same for every challenge.
        button.innerHTML = '<span class="map-card-marker__card"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5 14.2 9.8 22.5 12 14.2 14.2 12 22.5 9.8 14.2 1.5 12 9.8 9.8Z"/></svg></span><span class="map-card-marker__stem"></span><span class="map-card-marker__dot"></span>';
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
