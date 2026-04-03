import {
  DEFAULT_GPS_BUFFER_METERS,
  type GeoJsonGeometry,
  type GeoJsonLineString,
  type GeoJsonMultiPolygon,
  type GeoJsonPoint,
  type GeoJsonPolygon,
  type Zone,
} from '@city-game/shared';

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

export function findContainingZone(zones: Zone[], point: [number, number] | null): Zone | null {
  if (!point) {
    return null;
  }

  for (const zone of zones) {
    if (zone.isDisabled) {
      continue;
    }

    if (isPointInsideZone(zone, point)) {
      return zone;
    }
  }

  return null;
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

function isPointInsideZone(zone: Zone, point: [number, number]): boolean {
  const bufferMeters = zone.claimRadiusMeters ?? DEFAULT_GPS_BUFFER_METERS;

  switch (zone.geometry.type) {
    case 'Point': {
      const anchor: [number, number] = [zone.geometry.coordinates[0], zone.geometry.coordinates[1]];
      return (getDistanceMeters(point, anchor) ?? Number.POSITIVE_INFINITY) <= (zone.claimRadiusMeters ?? DEFAULT_POINT_ZONE_RADIUS_METERS);
    }
    case 'LineString':
      return distanceToLineStringMeters(point, zone.geometry) <= bufferMeters;
    case 'Polygon':
      return isPointInsidePolygon(point, zone.geometry, bufferMeters);
    case 'MultiPolygon':
      return zone.geometry.coordinates.some((coordinates) => isPointInsidePolygon(point, { type: 'Polygon', coordinates }, bufferMeters));
  }
}

function isPointInsidePolygon(point: [number, number], polygon: GeoJsonPolygon, bufferMeters: number): boolean {
  if (polygon.coordinates.length === 0) {
    return false;
  }

  if (isPointInRing(point, polygon.coordinates[0])) {
    const insideHole = polygon.coordinates.slice(1).some((ring) => isPointInRing(point, ring));
    if (!insideHole) {
      return true;
    }
  }

  return distanceToPolygonMeters(point, polygon) <= bufferMeters;
}

function distanceToPolygonMeters(point: [number, number], polygon: GeoJsonPolygon): number {
  let distance = Number.POSITIVE_INFINITY;

  for (const ring of polygon.coordinates) {
    distance = Math.min(distance, distanceToRingMeters(point, ring));
  }

  return distance;
}

function distanceToRingMeters(point: [number, number], ring: Array<[number, number] | number[]>): number {
  if (ring.length < 2) {
    return Number.POSITIVE_INFINITY;
  }

  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const start = ring[index] as [number, number];
    const end = ring[index + 1] as [number, number];
    distance = Math.min(distance, distanceToSegmentMeters(point, start, end));
  }

  return distance;
}

function distanceToLineStringMeters(point: [number, number], lineString: GeoJsonLineString): number {
  if (lineString.coordinates.length < 2) {
    return Number.POSITIVE_INFINITY;
  }

  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < lineString.coordinates.length - 1; index += 1) {
    const start = lineString.coordinates[index] as [number, number];
    const end = lineString.coordinates[index + 1] as [number, number];
    distance = Math.min(distance, distanceToSegmentMeters(point, start, end));
  }

  return distance;
}

function distanceToSegmentMeters(point: [number, number], start: [number, number], end: [number, number]): number {
  const referenceLat = (point[1] + start[1] + end[1]) / 3;
  const projectedPoint = projectToMeters(point, referenceLat);
  const projectedStart = projectToMeters(start, referenceLat);
  const projectedEnd = projectToMeters(end, referenceLat);

  const deltaX = projectedEnd[0] - projectedStart[0];
  const deltaY = projectedEnd[1] - projectedStart[1];
  const lengthSquared = (deltaX ** 2) + (deltaY ** 2);

  if (lengthSquared === 0) {
    return Math.hypot(projectedPoint[0] - projectedStart[0], projectedPoint[1] - projectedStart[1]);
  }

  const ratio = clamp(
    ((projectedPoint[0] - projectedStart[0]) * deltaX + (projectedPoint[1] - projectedStart[1]) * deltaY) / lengthSquared,
    0,
    1,
  );

  const projectedClosest: [number, number] = [
    projectedStart[0] + deltaX * ratio,
    projectedStart[1] + deltaY * ratio,
  ];

  return Math.hypot(projectedPoint[0] - projectedClosest[0], projectedPoint[1] - projectedClosest[1]);
}

function isPointInRing(point: [number, number], ring: Array<[number, number] | number[]>): boolean {
  let inside = false;

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [currentLng, currentLat] = ring[index] as [number, number];
    const [previousLng, previousLat] = ring[previous] as [number, number];

    const intersects = ((currentLat > point[1]) !== (previousLat > point[1]))
      && (point[0] < ((previousLng - currentLng) * (point[1] - currentLat)) / ((previousLat - currentLat) || Number.EPSILON) + currentLng);

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
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

function projectToMeters(point: [number, number], referenceLat: number): [number, number] {
  const referenceLatRadians = toRadians(referenceLat);
  return [
    toRadians(point[0]) * EARTH_RADIUS_METERS * Math.cos(referenceLatRadians),
    toRadians(point[1]) * EARTH_RADIUS_METERS,
  ];
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
