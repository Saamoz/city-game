import { useEffect } from 'react';
import type { Feature, FeatureCollection, GeoJsonProperties } from 'geojson';
import mapboxgl from 'mapbox-gl';
import type { GameStateSnapshot, GeoJsonGeometry, Zone } from '@city-game/shared';
import { buildRenderedZoneGeometry } from './mapGeometry';

interface ZoneLayerProps {
  map: mapboxgl.Map | null;
  snapshot: GameStateSnapshot | null;
}

const ZONE_SOURCE_ID = 'zones-source';
const ZONE_FILL_LAYER_ID = 'zones-fill-layer';
const ZONE_LINE_LAYER_ID = 'zones-line-layer';
const NEUTRAL_FILL = '#b8b9b3';
const NEUTRAL_LINE = '#7d817b';
const DESATURATED_BASE = '#c9c0af';

export function ZoneLayer({ map, snapshot }: ZoneLayerProps) {
  useEffect(() => {
    if (!map || !snapshot) {
      return;
    }

    const syncLayers = () => {
      if (!map.getStyle()) {
        return;
      }

      const collection = buildZoneCollection(snapshot);

      let source = map.getSource(ZONE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
      if (!source) {
        map.addSource(ZONE_SOURCE_ID, {
          type: 'geojson',
          data: collection,
        });

        source = map.getSource(ZONE_SOURCE_ID) as mapboxgl.GeoJSONSource;
      }

      source.setData(collection);

      if (!map.getLayer(ZONE_FILL_LAYER_ID)) {
        map.addLayer({
          id: ZONE_FILL_LAYER_ID,
          type: 'fill',
          source: ZONE_SOURCE_ID,
          filter: ['==', '$type', 'Polygon'],
          paint: {
            'fill-color': ['coalesce', ['get', 'fillColor'], NEUTRAL_FILL],
            'fill-opacity': ['coalesce', ['get', 'fillOpacity'], 0.18],
          },
        });
      }

      if (!map.getLayer(ZONE_LINE_LAYER_ID)) {
        map.addLayer({
          id: ZONE_LINE_LAYER_ID,
          type: 'line',
          source: ZONE_SOURCE_ID,
          paint: {
            'line-color': ['coalesce', ['get', 'lineColor'], NEUTRAL_LINE],
            'line-width': ['case', ['==', '$type', 'LineString'], 3.5, 2.2],
            'line-opacity': ['coalesce', ['get', 'lineOpacity'], 0.72],
          },
        });
      }
    };

    if (map.isStyleLoaded()) {
      syncLayers();
      return;
    }

    map.once('load', syncLayers);

    return () => {
      map.off('load', syncLayers);
      const canvas = typeof map.getCanvas === 'function' ? map.getCanvas() : null;
      if (canvas) {
        canvas.style.cursor = '';
      }
    };
  }, [map, snapshot]);

  return null;
}

function buildZoneCollection(snapshot: GameStateSnapshot): FeatureCollection<GeoJsonGeometry, GeoJsonProperties> {
  const teamColorById = new Map(snapshot.teams.map((team) => [team.id, team.color]));

  return {
    type: 'FeatureCollection',
    features: snapshot.zones.map((zone) => buildZoneFeature(
      zone,
      teamColorById.get(zone.ownerTeamId ?? '') ?? null,
    )),
  };
}

function buildZoneFeature(
  zone: Zone,
  ownerColor: string | null,
): Feature<GeoJsonGeometry, GeoJsonProperties> {
  const fillColor = ownerColor ? blendHex(ownerColor, DESATURATED_BASE, 0.62) : NEUTRAL_FILL;
  const lineColor = ownerColor ? blendHex(ownerColor, '#596166', 0.48) : NEUTRAL_LINE;

  return {
    type: 'Feature',
    id: zone.id,
    geometry: buildRenderedZoneGeometry(zone),
    properties: {
      id: zone.id,
      name: zone.name,
      pointValue: zone.pointValue,
      ownerTeamId: zone.ownerTeamId,
      fillColor,
      lineColor,
      fillOpacity: zone.ownerTeamId ? 0.24 : 0.14,
      lineOpacity: zone.ownerTeamId ? 0.82 : 0.58,
      isDisabled: zone.isDisabled,
      claimRadiusMeters: zone.claimRadiusMeters,
    },
  };
}

function blendHex(sourceColor: string, targetColor: string, targetWeight: number): string {
  const source = parseHexColor(sourceColor);
  const target = parseHexColor(targetColor);

  if (!source || !target) {
    return sourceColor;
  }

  const weight = clamp(targetWeight, 0, 1);
  const mix = source.map((value, index) => Math.round((value * (1 - weight)) + (target[index] * weight)));
  return '#' + mix.map((value) => value.toString(16).padStart(2, '0')).join('');
}

function parseHexColor(color: string): [number, number, number] | null {
  const normalized = color.trim().replace('#', '');
  const expanded = normalized.length === 3
    ? normalized.split('').map((part) => part + part).join('')
    : normalized;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    return null;
  }

  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
