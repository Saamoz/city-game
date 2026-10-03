import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { bbox as turfBbox, centroid as turfCentroid, point as turfPoint, pointToPolygonDistance } from '@turf/turf';
import { CHALLENGE_AREA_EDGE_TOLERANCE_METERS, getChallengeArea, type Challenge, type GeoJsonMultiPolygon, type GeoJsonPolygon } from '@city-game/shared';

// Challenges tied to a drawn area: shaded on the map, completed from anywhere inside.

const AREA_SOURCE_ID = 'challenge-areas';
const AREA_LABEL_SOURCE_ID = 'challenge-area-labels';
const AREA_FILL_LAYER_ID = 'challenge-area-fill';
const AREA_LINE_LAYER_ID = 'challenge-area-line';
const AREA_LABEL_LAYER_ID = 'challenge-area-label';

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
    const labels: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: visible.map((challenge) => ({
        ...turfCentroid(getChallengeArea(challenge.config) as GeoJSON.Polygon),
        properties: { id: challenge.id, title: challenge.title },
      })),
    };

    const sync = () => {
      if (!map.isStyleLoaded()) throw new Error('style not ready');
      upsertSource(map, AREA_SOURCE_ID, shapes);
      upsertSource(map, AREA_LABEL_SOURCE_ID, labels);
      if (!map.getLayer(AREA_FILL_LAYER_ID)) {
        map.addLayer({ id: AREA_FILL_LAYER_ID, type: 'fill', source: AREA_SOURCE_ID, paint: { 'fill-color': '#d97a37', 'fill-opacity': ['case', ['get', 'selected'], 0.26, 0.13] } });
      }
      if (!map.getLayer(AREA_LINE_LAYER_ID)) {
        map.addLayer({ id: AREA_LINE_LAYER_ID, type: 'line', source: AREA_SOURCE_ID, paint: { 'line-color': '#b4602a', 'line-width': ['case', ['get', 'selected'], 3, 2], 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 } });
      }
      if (!map.getLayer(AREA_LABEL_LAYER_ID)) {
        map.addLayer({
          id: AREA_LABEL_LAYER_ID,
          type: 'symbol',
          source: AREA_LABEL_SOURCE_ID,
          layout: { 'text-field': ['get', 'title'], 'text-size': 12, 'text-max-width': 9, 'text-allow-overlap': false },
          paint: { 'text-color': '#7a3f17', 'text-halo-color': '#fff8eb', 'text-halo-width': 1.6 },
        });
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
    const handleClick = (event: mapboxgl.MapLayerMouseEvent) => {
      const id = event.features?.[0]?.properties?.id;
      if (typeof id === 'string') onSelectRef.current(id);
    };
    const setPointer = () => { map.getCanvas().style.cursor = 'pointer'; };
    const clearPointer = () => { map.getCanvas().style.cursor = ''; };
    map.on('click', AREA_FILL_LAYER_ID, handleClick);
    map.on('mouseenter', AREA_FILL_LAYER_ID, setPointer);
    map.on('mouseleave', AREA_FILL_LAYER_ID, clearPointer);
    return () => {
      map.off('click', AREA_FILL_LAYER_ID, handleClick);
      map.off('mouseenter', AREA_FILL_LAYER_ID, setPointer);
      map.off('mouseleave', AREA_FILL_LAYER_ID, clearPointer);
    };
  }, [map]);

  return null;
}

function upsertSource(map: mapboxgl.Map, id: string, data: GeoJSON.FeatureCollection) {
  const source = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
  if (source) source.setData(data);
  else map.addSource(id, { type: 'geojson', data });
}
