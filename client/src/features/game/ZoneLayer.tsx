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
            'fill-color': ['coalesce', ['get', 'ownerColor'], '#d8c3a1'],
            'fill-opacity': 0.38,
          },
        });
      }

      if (!map.getLayer(ZONE_LINE_LAYER_ID)) {
        map.addLayer({
          id: ZONE_LINE_LAYER_ID,
          type: 'line',
          source: ZONE_SOURCE_ID,
          paint: {
            'line-color': ['coalesce', ['get', 'ownerColor'], '#8f6f3d'],
            'line-width': ['case', ['==', '$type', 'LineString'], 4, 3],
            'line-opacity': 0.95,
          },
        });
      }

      if (!map.getLayer(ZONE_POINT_LAYER_ID)) {
        map.addLayer({
          id: ZONE_POINT_LAYER_ID,
          type: 'circle',
          source: ZONE_SOURCE_ID,
          filter: ['==', '$type', 'Point'],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'claimRadiusMeters'], 80], 40, 8, 120, 18],
            'circle-color': ['coalesce', ['get', 'ownerColor'], '#f0dcc0'],
            'circle-opacity': 0.85,
            'circle-stroke-width': 3,
            'circle-stroke-color': '#1f2a2f',
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
