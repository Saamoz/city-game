import type { GeoJsonGeometry } from './types.js';

type Position = [number, number];

export interface BoundaryEditZone {
  id: string;
  geometry: GeoJsonGeometry;
}

export interface SharedBoundaryEditResult {
  geometries: Record<string, GeoJsonGeometry>;
  affectedZoneIds: string[];
}

interface VertexReplacement {
  from: Position;
  to: Position;
}

interface VertexInsertion {
  start: Position;
  end: Position;
  point: Position;
}

interface VertexDeletion {
  previous: Position;
  point: Position;
  next: Position;
}

interface RingEdit {
  cost: number;
  replacements: VertexReplacement[];
  insertion?: VertexInsertion;
  deletion?: VertexDeletion;
}

interface BoundaryEdits {
  replacements: VertexReplacement[];
  insertions: VertexInsertion[];
  deletions: VertexDeletion[];
}

const COORDINATE_EPSILON = 1e-10;

export function propagateSharedBoundaryEdit(
  selectedZoneId: string,
  previousGeometry: GeoJsonGeometry,
  nextGeometry: GeoJsonGeometry,
  zones: BoundaryEditZone[],
): SharedBoundaryEditResult {
  const edits = buildBoundaryEdits(previousGeometry, nextGeometry);
  const geometries: Record<string, GeoJsonGeometry> = {
    [selectedZoneId]: nextGeometry,
  };

  for (const zone of zones) {
    if (zone.id === selectedZoneId) {
      continue;
    }

    const nextNeighborGeometry = applyBoundaryEdits(zone.geometry, edits);
    if (!geometryCoordinatesEqual(zone.geometry, nextNeighborGeometry)) {
      geometries[zone.id] = nextNeighborGeometry;
    }
  }

  return {
    geometries,
    affectedZoneIds: Object.keys(geometries),
  };
}

function buildBoundaryEdits(
  previousGeometry: GeoJsonGeometry,
  nextGeometry: GeoJsonGeometry,
): BoundaryEdits {
  if (previousGeometry.type !== 'Polygon' || nextGeometry.type !== 'Polygon') {
    throw new Error('Synchronized boundary editing currently requires polygon zones.');
  }
  if (previousGeometry.coordinates.length !== nextGeometry.coordinates.length) {
    throw new Error('Adding or removing polygon holes is not supported in synchronized boundary editing.');
  }

  const edits: BoundaryEdits = {
    replacements: [],
    insertions: [],
    deletions: [],
  };

  for (let ringIndex = 0; ringIndex < previousGeometry.coordinates.length; ringIndex += 1) {
    const previousRing = stripClosingPosition(previousGeometry.coordinates[ringIndex] as Position[]);
    const nextRing = stripClosingPosition(nextGeometry.coordinates[ringIndex] as Position[]);
    const ringEdit = findBestRingEdit(previousRing, nextRing);

    for (const replacement of ringEdit.replacements) {
      if (!positionsEqual(replacement.from, replacement.to)) {
        addReplacement(edits.replacements, replacement);
      }
    }
    if (ringEdit.insertion) {
      edits.insertions.push(ringEdit.insertion);
    }
    if (ringEdit.deletion) {
      edits.deletions.push(ringEdit.deletion);
    }
  }

  return edits;
}

function findBestRingEdit(previousRing: Position[], nextRing: Position[]): RingEdit {
  if (previousRing.length < 3 || nextRing.length < 3) {
    throw new Error('Zone rings must contain at least three vertices.');
  }
  if (Math.abs(previousRing.length - nextRing.length) > 1) {
    throw new Error('Add or remove one boundary vertex at a time.');
  }

  let best: RingEdit | null = null;
  const orientations = [nextRing, [...nextRing].reverse()];

  for (const orientation of orientations) {
    for (let offset = 0; offset < orientation.length; offset += 1) {
      const candidate = rotateRing(orientation, offset);
      const edit = compareRings(previousRing, candidate);
      if (!best || edit.cost < best.cost) {
        best = edit;
      }
    }
  }

  if (!best) {
    throw new Error('Unable to align edited zone boundary.');
  }
  return best;
}

function compareRings(previousRing: Position[], nextRing: Position[]): RingEdit {
  if (previousRing.length === nextRing.length) {
    return {
      cost: sequenceCost(previousRing, nextRing),
      replacements: previousRing.map((from, index) => ({ from, to: nextRing[index] })),
    };
  }

  if (nextRing.length === previousRing.length + 1) {
    let best: RingEdit | null = null;
    for (let insertedIndex = 0; insertedIndex < nextRing.length; insertedIndex += 1) {
      const reduced = nextRing.filter((_position, index) => index !== insertedIndex);
      const cost = sequenceCost(previousRing, reduced);
      const edit: RingEdit = {
        cost,
        replacements: previousRing.map((from, index) => ({ from, to: reduced[index] })),
        insertion: {
          start: previousRing[(insertedIndex - 1 + previousRing.length) % previousRing.length],
          end: previousRing[insertedIndex % previousRing.length],
          point: nextRing[insertedIndex],
        },
      };
      if (!best || edit.cost < best.cost) {
        best = edit;
      }
    }
    return best!;
  }

  let best: RingEdit | null = null;
  for (let deletedIndex = 0; deletedIndex < previousRing.length; deletedIndex += 1) {
    const reduced = previousRing.filter((_position, index) => index !== deletedIndex);
    const cost = sequenceCost(reduced, nextRing);
    const edit: RingEdit = {
      cost,
      replacements: reduced.map((from, index) => ({ from, to: nextRing[index] })),
      deletion: {
        previous: previousRing[(deletedIndex - 1 + previousRing.length) % previousRing.length],
        point: previousRing[deletedIndex],
        next: previousRing[(deletedIndex + 1) % previousRing.length],
      },
    };
    if (!best || edit.cost < best.cost) {
      best = edit;
    }
  }
  return best!;
}

function applyBoundaryEdits(geometry: GeoJsonGeometry, edits: BoundaryEdits): GeoJsonGeometry {
  if (geometry.type === 'Polygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((ring) => applyRingEdits(ring as Position[], edits)),
    };
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((polygon) =>
        polygon.map((ring) => applyRingEdits(ring as Position[], edits)),
      ),
    };
  }
  return geometry;
}

function applyRingEdits(closedRing: Position[], edits: BoundaryEdits): Position[] {
  let ring = stripClosingPosition(closedRing);

  for (const replacement of edits.replacements) {
    ring = insertVertexOnContainingSegment(ring, replacement.from);
  }
  for (const deletion of edits.deletions) {
    ring = deleteSharedVertex(ring, deletion);
  }
  for (const insertion of edits.insertions) {
    ring = insertSharedVertex(ring, insertion);
  }

  ring = ring.map((position) => {
    const replacement = edits.replacements.find((entry) => positionsEqual(entry.from, position));
    return replacement ? replacement.to : position;
  });
  ring = removeConsecutiveDuplicates(ring);

  return ring.length > 0 ? [...ring, ring[0]] : closedRing;
}

function insertVertexOnContainingSegment(ring: Position[], point: Position): Position[] {
  if (ring.some((position) => positionsEqual(position, point))) {
    return ring;
  }

  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    if (pointLiesOnSegment(point, start, end)) {
      return [
        ...ring.slice(0, index + 1),
        point,
        ...ring.slice(index + 1),
      ];
    }
  }
  return ring;
}

function insertSharedVertex(ring: Position[], insertion: VertexInsertion): Position[] {
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    if (
      (positionsEqual(start, insertion.start) && positionsEqual(end, insertion.end))
      || (positionsEqual(start, insertion.end) && positionsEqual(end, insertion.start))
    ) {
      return [
        ...ring.slice(0, index + 1),
        insertion.point,
        ...ring.slice(index + 1),
      ];
    }
  }
  return ring;
}

function deleteSharedVertex(ring: Position[], deletion: VertexDeletion): Position[] {
  if (ring.length <= 3) {
    return ring;
  }

  for (let index = 0; index < ring.length; index += 1) {
    const previous = ring[(index - 1 + ring.length) % ring.length];
    const point = ring[index];
    const next = ring[(index + 1) % ring.length];
    if (
      positionsEqual(point, deletion.point)
      && (
        (positionsEqual(previous, deletion.previous) && positionsEqual(next, deletion.next))
        || (positionsEqual(previous, deletion.next) && positionsEqual(next, deletion.previous))
      )
    ) {
      return ring.filter((_position, candidateIndex) => candidateIndex !== index);
    }
  }
  return ring;
}

function addReplacement(replacements: VertexReplacement[], nextReplacement: VertexReplacement): void {
  const existing = replacements.find((entry) => positionsEqual(entry.from, nextReplacement.from));
  if (existing && !positionsEqual(existing.to, nextReplacement.to)) {
    throw new Error('A shared vertex cannot move to two different positions.');
  }
  if (!existing) {
    replacements.push(nextReplacement);
  }
}

function stripClosingPosition(ring: Position[]): Position[] {
  if (ring.length > 1 && positionsEqual(ring[0], ring[ring.length - 1])) {
    return ring.slice(0, -1).map(copyPosition);
  }
  return ring.map(copyPosition);
}

function rotateRing(ring: Position[], offset: number): Position[] {
  return [...ring.slice(offset), ...ring.slice(0, offset)];
}

function sequenceCost(left: Position[], right: Position[]): number {
  return left.reduce((cost, position, index) => cost + squaredDistance(position, right[index]), 0);
}

function squaredDistance(left: Position, right: Position): number {
  const deltaLng = left[0] - right[0];
  const deltaLat = left[1] - right[1];
  return (deltaLng * deltaLng) + (deltaLat * deltaLat);
}

function positionsEqual(left: Position, right: Position): boolean {
  return Math.abs(left[0] - right[0]) <= COORDINATE_EPSILON
    && Math.abs(left[1] - right[1]) <= COORDINATE_EPSILON;
}

function pointLiesOnSegment(point: Position, start: Position, end: Position): boolean {
  const segmentLng = end[0] - start[0];
  const segmentLat = end[1] - start[1];
  const pointLng = point[0] - start[0];
  const pointLat = point[1] - start[1];
  const crossProduct = (segmentLng * pointLat) - (segmentLat * pointLng);
  const segmentLength = Math.hypot(segmentLng, segmentLat);
  if (Math.abs(crossProduct) > COORDINATE_EPSILON * Math.max(1, segmentLength)) {
    return false;
  }

  const dotProduct = (pointLng * segmentLng) + (pointLat * segmentLat);
  const lengthSquared = (segmentLng * segmentLng) + (segmentLat * segmentLat);
  return dotProduct > COORDINATE_EPSILON && dotProduct < lengthSquared - COORDINATE_EPSILON;
}

function geometryCoordinatesEqual(left: GeoJsonGeometry, right: GeoJsonGeometry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function removeConsecutiveDuplicates(ring: Position[]): Position[] {
  return ring.filter((position, index) => index === 0 || !positionsEqual(position, ring[index - 1]));
}

function copyPosition(position: Position): Position {
  return [position[0], position[1]];
}
