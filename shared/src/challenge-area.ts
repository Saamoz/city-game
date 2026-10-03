import type { GeoJsonMultiPolygon, GeoJsonPolygon } from './types.js';

// A challenge can be tied to a custom area drawn on the map (`config.area`): it shows as a shaded
// shape and is completed from anywhere inside it. A little slack absorbs GPS drift at the edge.
export const CHALLENGE_AREA_EDGE_TOLERANCE_METERS = 20;

export function getChallengeArea(config: unknown): GeoJsonPolygon | GeoJsonMultiPolygon | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const area = (config as { area?: unknown }).area;
  return isAreaGeometry(area) ? area : null;
}

export function isAreaGeometry(value: unknown): value is GeoJsonPolygon | GeoJsonMultiPolygon {
  if (!value || typeof value !== 'object') return false;
  const { type, coordinates } = value as { type?: unknown; coordinates?: unknown };
  const isRing = (ring: unknown) => Array.isArray(ring) && ring.length >= 4 && ring.every((position) => Array.isArray(position) && typeof position[0] === 'number' && typeof position[1] === 'number');
  const isPolygon = (polygon: unknown) => Array.isArray(polygon) && polygon.length >= 1 && polygon.every(isRing);
  if (type === 'Polygon') return isPolygon(coordinates);
  if (type === 'MultiPolygon') return Array.isArray(coordinates) && coordinates.length >= 1 && coordinates.every(isPolygon);
  return false;
}
