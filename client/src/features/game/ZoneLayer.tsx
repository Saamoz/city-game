import { useEffect } from 'react';
import type { Feature, FeatureCollection, GeoJsonProperties } from 'geojson';
import mapboxgl from 'mapbox-gl';
import type { GameStateSnapshot, GeoJsonGeometry, GeoJsonPoint, GeoJsonPolygon, Zone } from '@city-game/shared';

interface ZoneLayerProps {
  map: mapboxgl.Map | null;
  snapshot: GameStateSnapshot | null;
}

const ZONE_SOURCE_ID = 'zones-source';
const ZONE_FILL_LAYER_ID = 'zones-fill-layer';
const ZONE_LINE_LAYER_ID = 'zones-line-layer';
const DEFAULT_POINT_ZONE_RADIUS_METERS = 80;
const EARTH_RADIUS_METERS = 6_378_137;
const CIRCLE_SEGMENTS = 48;

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
  const geometry = buildRenderedZoneGeometry(zone);

  return {
    type: 'Feature',
    id: zone.id,
    geometry,
    properties: {
      id: zone.id,
      name: zone.name,
      pointValue: zone.pointValue,
      ownerTeamId: zone.ownerTeamId,
      ownerColor,
      isDisabled: zone.isDisabled,
      claimRadiusMeters: zone.claimRadiusMeters,
      originalGeometryType: zone.geometry.type,
    },
  };
}

function buildRenderedZoneGeometry(zone: Zone): GeoJsonGeometry {
  if (zone.geometry.type !== 'Point') {
    return zone.geometry;
  }

  return bufferPointToPolygon(zone.geometry, zone.claimRadiusMeters ?? DEFAULT_POINT_ZONE_RADIUS_METERS);
}

function bufferPointToPolygon(point: GeoJsonPoint, radiusMeters: number): GeoJsonPolygon {
  const [lng, lat] = point.coordinates;
  const lngLatCoordinates: Array<[number, number]> = [];

  for (let index = 0; index <= CIRCLE_SEGMENTS; index += 1) {
    const bearingRadians = (index / CIRCLE_SEGMENTS) * Math.PI * 2;
    lngLatCoordinates.push(destinationPoint(lng, lat, radiusMeters, bearingRadians));
  }

  return {
    type: 'Polygon',
    coordinates: [lngLatCoordinates],
  };
}

function destinationPoint(
  lngDegrees: number,
  latDegrees: number,
  distanceMeters: number,
  bearingRadians: number,
): [number, number] {
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const latRadians = toRadians(latDegrees);
  const lngRadians = toRadians(lngDegrees);

  const nextLat = Math.asin(
    Math.sin(latRadians) * Math.cos(angularDistance)
      + Math.cos(latRadians) * Math.sin(angularDistance) * Math.cos(bearingRadians),
  );

  const nextLng = lngRadians + Math.atan2(
    Math.sin(bearingRadians) * Math.sin(angularDistance) * Math.cos(latRadians),
    Math.cos(angularDistance) - Math.sin(latRadians) * Math.sin(nextLat),
  );

  return [normalizeLongitude(toDegrees(nextLng)), toDegrees(nextLat)];
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function toDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function normalizeLongitude(value: number): number {
  return ((value + 540) % 360) - 180;
}
