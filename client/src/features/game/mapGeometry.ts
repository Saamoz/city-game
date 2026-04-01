import type { GeoJsonGeometry, GeoJsonPoint, GeoJsonPolygon, Zone } from '@city-game/shared';

const DEFAULT_POINT_ZONE_RADIUS_METERS = 80;
const EARTH_RADIUS_METERS = 6_378_137;
const CIRCLE_SEGMENTS = 48;

export function collectGeometryPositions(geometry: GeoJsonGeometry): Array<[number, number]> {
  switch (geometry.type) {
    case 'Point':
      return [[geometry.coordinates[0], geometry.coordinates[1]]];
    case 'LineString':
      return geometry.coordinates.map((position) => [position[0], position[1]] as [number, number]);
    case 'Polygon':
      return geometry.coordinates.flat().map((position) => [position[0], position[1]] as [number, number]);
    case 'MultiPolygon':
      return geometry.coordinates.flat(2).map((position) => [position[0], position[1]] as [number, number]);
  }
}

export function buildRenderedZoneGeometry(zone: Zone): GeoJsonGeometry {
  if (zone.geometry.type !== 'Point') {
    return zone.geometry;
  }

  return bufferPointToPolygon(zone.geometry, zone.claimRadiusMeters ?? DEFAULT_POINT_ZONE_RADIUS_METERS);
}

export function getZoneAnchor(zone: Zone): [number, number] {
  if (zone.centroid?.type === 'Point') {
    return [zone.centroid.coordinates[0], zone.centroid.coordinates[1]];
  }

  if (zone.geometry.type === 'Point') {
    return [zone.geometry.coordinates[0], zone.geometry.coordinates[1]];
  }

  const positions = collectGeometryPositions(zone.geometry);
  if (positions.length === 0) {
    return [0, 0];
  }

  const sums = positions.reduce(
    (accumulator, [lng, lat]) => {
      accumulator.lng += lng;
      accumulator.lat += lat;
      return accumulator;
    },
    { lng: 0, lat: 0 },
  );

  return [sums.lng / positions.length, sums.lat / positions.length];
}

export function formatDistance(distanceMeters: number | null): string {
  if (distanceMeters === null || Number.isNaN(distanceMeters)) {
    return 'Distance unavailable';
  }

  if (distanceMeters >= 1000) {
    const km = (distanceMeters / 1000).toFixed(distanceMeters >= 10 ? 0 : 1);
    return km + ' km away';
  }

  return String(Math.round(distanceMeters)) + ' m away';
}

export function getDistanceMeters(
  from: [number, number] | null,
  to: [number, number] | null,
): number | null {
  if (!from || !to) {
    return null;
  }

  const [fromLng, fromLat] = from;
  const [toLng, toLat] = to;

  const deltaLat = toRadians(toLat - fromLat);
  const deltaLng = toRadians(toLng - fromLng);
  const fromLatRadians = toRadians(fromLat);
  const toLatRadians = toRadians(toLat);

  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(fromLatRadians) * Math.cos(toLatRadians) * Math.sin(deltaLng / 2) ** 2;
  const arc = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));

  return EARTH_RADIUS_METERS * arc;
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
