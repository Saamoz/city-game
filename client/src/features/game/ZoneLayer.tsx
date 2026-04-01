import { useEffect } from 'react';
import type { Feature, FeatureCollection, GeoJsonProperties } from 'geojson';
import mapboxgl from 'mapbox-gl';
import type { GameStateSnapshot, GeoJsonGeometry, Zone } from '@city-game/shared';

interface ZoneLayerProps {
  map: mapboxgl.Map | null;
  snapshot: GameStateSnapshot | null;
}

const ZONE_SOURCE_ID = 'zones-source';
const ZONE_FILL_LAYER_ID = 'zones-fill-layer';
const ZONE_LINE_LAYER_ID = 'zones-line-layer';
const ZONE_POINT_LAYER_ID = 'zones-point-layer';

export function ZoneLayer({ map, snapshot }: ZoneLayerProps) {
  useEffect(() => {
    if (!map || !snapshot) {
      return;
    }

    const syncLayers = () => {
      const collection = buildZoneCollection(snapshot);

      const source = map.getSource(ZONE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
      if (!source) {
        map.addSource(ZONE_SOURCE_ID, {
          type: 'geojson',
          data: collection,
        });

        map.addLayer({
          id: ZONE_FILL_LAYER_ID,
          type: 'fill',
          source: ZONE_SOURCE_ID,
          filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
          paint: {
            'fill-color': ['coalesce', ['get', 'ownerColor'], '#334155'],
            'fill-opacity': 0.28,
          },
        });

        map.addLayer({
          id: ZONE_LINE_LAYER_ID,
          type: 'line',
          source: ZONE_SOURCE_ID,
          paint: {
            'line-color': ['coalesce', ['get', 'ownerColor'], '#94a3b8'],
            'line-width': [
              'case',
              ['==', ['geometry-type'], 'LineString'],
              4,
              2,
            ],
            'line-opacity': 0.95,
          },
        });

        map.addLayer({
          id: ZONE_POINT_LAYER_ID,
          type: 'circle',
          source: ZONE_SOURCE_ID,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 12,
            'circle-color': ['coalesce', ['get', 'ownerColor'], '#f8fafc'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#020617',
          },
        });
        return;
      }

      source.setData(collection);
    };

    if (map.isStyleLoaded()) {
      syncLayers();
      return;
    }

    map.once('load', syncLayers);

    return () => {
      map.off('load', syncLayers);
    };
  }, [map, snapshot]);

  return null;
}

function buildZoneCollection(snapshot: GameStateSnapshot): FeatureCollection<GeoJsonGeometry, GeoJsonProperties> {
  const teamColorById = new Map(snapshot.teams.map((team) => [team.id, team.color]));

  return {
    type: 'FeatureCollection',
    features: snapshot.zones.map((zone) => buildZoneFeature(zone, teamColorById.get(zone.ownerTeamId ?? '') ?? null)),
  };
}

function buildZoneFeature(zone: Zone, ownerColor: string | null): Feature<GeoJsonGeometry, GeoJsonProperties> {
  return {
    type: 'Feature',
    id: zone.id,
    geometry: zone.geometry,
    properties: {
      id: zone.id,
      name: zone.name,
      pointValue: zone.pointValue,
      ownerTeamId: zone.ownerTeamId,
      ownerColor,
      isDisabled: zone.isDisabled,
      claimRadiusMeters: zone.claimRadiusMeters,
    },
  };
}
