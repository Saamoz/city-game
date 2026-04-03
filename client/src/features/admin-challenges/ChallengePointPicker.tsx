import { useEffect, useMemo, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { GeoJsonFeatureCollection, GeoJsonGeometry, GeoJsonPoint, JsonObject, MapDefinition, MapZone } from '@city-game/shared';

interface ChallengePointPickerProps {
  mapDefinition: MapDefinition | null;
  zones: MapZone[];
  value: GeoJsonPoint | null;
  onChange(point: GeoJsonPoint): void;
}

const mapboxToken = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? import.meta.env.MAPBOX_ACCESS_TOKEN ?? '').trim();
const MAP_STYLE = 'mapbox://styles/saamoz/cmng3j80c004001s831aw5e3b';
const ZONE_SOURCE_ID = 'challenge-point-picker-zones';
const POINT_SOURCE_ID = 'challenge-point-picker-point';

export function ChallengePointPicker({ mapDefinition, zones, value, onChange }: ChallengePointPickerProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const zoneData = useMemo(() => buildZoneFeatureCollection(zones), [zones]);
  const pointData = useMemo(() => buildPointFeatureCollection(value), [value]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current || !mapDefinition || !mapboxToken) {
      return;
    }

    mapboxgl.accessToken = mapboxToken;
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: [mapDefinition.centerLng, mapDefinition.centerLat],
      zoom: mapDefinition.defaultZoom,
      attributionControl: false,
      dragRotate: false,
      touchPitch: false,
      pitchWithRotate: false,
      performanceMetricsCollection: false,
    });

    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

    const handleLoad = () => {
      ensureLayers(map);
      syncZoneSource(map, zoneData);
      syncPointSource(map, pointData);
      fitToMapContent(map, mapDefinition, zones, value);
    };

    const handleClick = (event: mapboxgl.MapMouseEvent) => {
      onChange({
        type: 'Point',
        coordinates: [event.lngLat.lng, event.lngLat.lat],
      });
    };

    map.on('load', handleLoad);
    map.on('click', handleClick);

    return () => {
      map.off('load', handleLoad);
      map.off('click', handleClick);
      map.remove();
      mapRef.current = null;
    };
  }, [mapDefinition, onChange, pointData, zoneData, zones, value]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapDefinition) {
      return;
    }

    syncZoneSource(map, zoneData);
    syncPointSource(map, pointData);
    fitToMapContent(map, mapDefinition, zones, value);
  }, [mapDefinition, pointData, zoneData, zones, value]);

  if (!mapDefinition) {
    return <PickerNotice body="Choose a source map before placing a point." />;
  }

  if (!mapboxToken) {
    return <PickerNotice body="Mapbox token required to place a point on the map." />;
  }

  return (
    <div className="overflow-hidden rounded-[1.25rem] border border-[#c8b48a]/55 bg-[#fff8eb]">
      <div ref={mapContainerRef} className="h-64 w-full" />
      <div className="border-t border-[#d6c59d]/55 px-4 py-3 text-xs leading-6 text-[#5a6a70]">
        Click the map to place the authored point.
      </div>
    </div>
  );
}

function PickerNotice({ body }: { body: string }) {
  return <div className="rounded-[1.25rem] border border-dashed border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-5 text-sm leading-6 text-[#5a6a70]">{body}</div>;
}

function ensureLayers(map: mapboxgl.Map): void {
  if (!map.getSource(ZONE_SOURCE_ID)) {
    map.addSource(ZONE_SOURCE_ID, {
      type: 'geojson',
      data: emptyFeatureCollection(),
    });
  }

  if (!map.getLayer('challenge-point-picker-zone-fill')) {
    map.addLayer({
      id: 'challenge-point-picker-zone-fill',
      type: 'fill',
      source: ZONE_SOURCE_ID,
      paint: {
        'fill-color': '#b79f68',
        'fill-opacity': 0.18,
      },
    });
  }

  if (!map.getLayer('challenge-point-picker-zone-line')) {
    map.addLayer({
      id: 'challenge-point-picker-zone-line',
      type: 'line',
      source: ZONE_SOURCE_ID,
      paint: {
        'line-color': '#7a6231',
        'line-width': 1.4,
        'line-opacity': 0.72,
      },
    });
  }

  if (!map.getSource(POINT_SOURCE_ID)) {
    map.addSource(POINT_SOURCE_ID, {
      type: 'geojson',
      data: emptyFeatureCollection(),
    });
  }

  if (!map.getLayer('challenge-point-picker-point-ring')) {
    map.addLayer({
      id: 'challenge-point-picker-point-ring',
      type: 'circle',
      source: POINT_SOURCE_ID,
      paint: {
        'circle-radius': 11,
        'circle-color': '#24343a',
        'circle-stroke-color': '#fff8eb',
        'circle-stroke-width': 2,
      },
    });
  }

  if (!map.getLayer('challenge-point-picker-point-core')) {
    map.addLayer({
      id: 'challenge-point-picker-point-core',
      type: 'circle',
      source: POINT_SOURCE_ID,
      paint: {
        'circle-radius': 4.5,
        'circle-color': '#d97a37',
      },
    });
  }
}

function syncZoneSource(map: mapboxgl.Map, data: GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject>) {
  const source = map.getSource(ZONE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
  source?.setData(data as GeoJSON.FeatureCollection);
}

function syncPointSource(map: mapboxgl.Map, data: GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject>) {
  const source = map.getSource(POINT_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
  source?.setData(data as GeoJSON.FeatureCollection);
}

function buildZoneFeatureCollection(zones: MapZone[]): GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> {
  return {
    type: 'FeatureCollection',
    features: zones.map((zone) => ({
      type: 'Feature',
      geometry: zone.geometry,
      properties: {
        id: zone.id,
        name: zone.name,
      },
    })),
  };
}

function buildPointFeatureCollection(point: GeoJsonPoint | null): GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> {
  return {
    type: 'FeatureCollection',
    features: point ? [{ type: 'Feature', geometry: point, properties: {} }] : [],
  };
}

function emptyFeatureCollection(): GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> {
  return { type: 'FeatureCollection', features: [] };
}

function fitToMapContent(
  map: mapboxgl.Map,
  mapDefinition: MapDefinition,
  zones: MapZone[],
  point: GeoJsonPoint | null,
): void {
  const positions = zones.flatMap((zone) => extractPositions(zone.geometry));
  if (point) {
    positions.push([point.coordinates[0] as number, point.coordinates[1] as number]);
  }

  if (positions.length === 0) {
    map.easeTo({ center: [mapDefinition.centerLng, mapDefinition.centerLat], zoom: mapDefinition.defaultZoom, duration: 0 });
    return;
  }

  const bounds = new mapboxgl.LngLatBounds(positions[0], positions[0]);
  for (const position of positions.slice(1)) {
    bounds.extend(position);
  }
  map.fitBounds(bounds, { padding: 44, maxZoom: 14.5, duration: 0 });
}

function extractPositions(geometry: GeoJsonGeometry): Array<[number, number]> {
  switch (geometry.type) {
    case 'Point':
      return [[geometry.coordinates[0] as number, geometry.coordinates[1] as number]];
    case 'LineString':
      return geometry.coordinates.map((position) => [position[0] as number, position[1] as number]);
    case 'Polygon':
      return geometry.coordinates.flat().map((position) => [position[0] as number, position[1] as number]);
    case 'MultiPolygon':
      return geometry.coordinates.flat(2).map((position) => [position[0] as number, position[1] as number]);
  }
}
