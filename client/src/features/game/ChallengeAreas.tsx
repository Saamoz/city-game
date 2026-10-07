import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { bbox as turfBbox, point as turfPoint, pointToPolygonDistance } from '@turf/turf';
import { CHALLENGE_AREA_EDGE_TOLERANCE_METERS, getChallengeArea, type Challenge, type GeoJsonMultiPolygon, type GeoJsonPolygon } from '@city-game/shared';

// Challenges tied to a drawn area: shaded on the map, completed from anywhere inside.

const AREA_SOURCE_ID = 'challenge-areas';
const AREA_FILL_LAYER_ID = 'challenge-area-fill';
const AREA_LINE_LAYER_ID = 'challenge-area-line';

export function isAreaChallenge(challenge: Challenge): boolean {
  return getChallengeArea(challenge.config) !== null;
}

// Metres from the player to the area; 0 when inside.
export function getAreaDistance(challenge: Challenge, position: [number, number] | null): number | null {
  const area = getChallengeArea(challenge.config);
  if (!area || !position) return null;
  const distance = pointToPolygonDistance(turfPoint(position), area as GeoJSON.Polygon | GeoJSON.MultiPolygon, { units: 'meters' });
  return Math.max(0, distance);
}

export function isInsideArea(distance: number | null): boolean {
  return distance !== null && distance <= CHALLENGE_AREA_EDGE_TOLERANCE_METERS;
}

export function getAreaBounds(area: GeoJsonPolygon | GeoJsonMultiPolygon): mapboxgl.LngLatBoundsLike {
  const [west, south, east, north] = turfBbox(area as GeoJSON.Polygon);
  return [[west, south], [east, north]];
}

interface LayerProps {
  map: mapboxgl.Map | null;
  challenges: Challenge[];
  selectedId: string | null;
  onSelect(id: string): void;
}

export function ChallengeAreaLayer({ map, challenges, selectedId, onSelect }: LayerProps) {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!map) return;
    const visible = challenges.filter((challenge) => challenge.status === 'available' && isAreaChallenge(challenge));
    const shapes: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: visible.map((challenge) => ({
        type: 'Feature',
        geometry: getChallengeArea(challenge.config) as GeoJSON.Geometry,
        properties: { id: challenge.id, selected: challenge.id === selectedId },
      })),
    };

    const sync = () => {
      // Not isStyleLoaded(): that stays false while tiles load. addSource throws until the style itself is in.
      upsertSource(map, AREA_SOURCE_ID, shapes);
      if (!map.getLayer(AREA_FILL_LAYER_ID)) {
        map.addLayer({ id: AREA_FILL_LAYER_ID, type: 'fill', source: AREA_SOURCE_ID, paint: { 'fill-color': '#a9774f', 'fill-opacity': ['case', ['get', 'selected'], 0.24, 0.14] } });
      }
      if (!map.getLayer(AREA_LINE_LAYER_ID)) {
        map.addLayer({ id: AREA_LINE_LAYER_ID, type: 'line', source: AREA_SOURCE_ID, paint: { 'line-color': '#7d5a3f', 'line-width': ['case', ['get', 'selected'], 2.4, 1.5], 'line-dasharray': [3, 2], 'line-opacity': 0.7 } });
      }
    };

    // The style can still be settling after 'load' has fired, and 'idle' may already have passed,
    // so retry on every style update until the layers are in.
    const attempt = () => {
      try { sync(); return true; } catch { return false; }
    };
    let timer: number | null = null;
    const stop = () => {
      map.off('styledata', retry);
      map.off('idle', retry);
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    function retry() { if (attempt()) stop(); }
    if (!attempt()) {
      map.on('styledata', retry);
      map.on('idle', retry);
      // A map that is already idle fires neither event, so also poll briefly.
      timer = window.setInterval(retry, 300);
    }
    return stop;
  }, [map, challenges, selectedId]);

  useEffect(() => {
    if (!map) return;
    // Listen on the map and look up the area under the tap: layer-scoped listeners attached before the
    // layer exists never fire.
    const areaAt = (point: mapboxgl.Point) => map.getLayer(AREA_FILL_LAYER_ID) ? map.queryRenderedFeatures(point, { layers: [AREA_FILL_LAYER_ID] })[0] : undefined;
    const handleClick = (event: mapboxgl.MapMouseEvent) => {
      const id = areaAt(event.point)?.properties?.id;
      if (typeof id === 'string') onSelectRef.current(id);
    };
    const handleMove = (event: mapboxgl.MapMouseEvent) => {
      map.getCanvas().style.cursor = areaAt(event.point) ? 'pointer' : '';
    };
    map.on('click', handleClick);
    map.on('mousemove', handleMove);
    return () => {
      map.off('click', handleClick);
      map.off('mousemove', handleMove);
    };
  }, [map]);

  return null;
}

function upsertSource(map: mapboxgl.Map, id: string, data: GeoJSON.FeatureCollection) {
  const source = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
  if (source) source.setData(data);
  else map.addSource(id, { type: 'geojson', data });
}
