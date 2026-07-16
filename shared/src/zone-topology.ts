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

  // Moving one or more vertices in place never changes ring length or vertex
  // order, so the correspondence is just "same index" — no need to search
  // for an alignment. Skipping the search here also avoids picking a wrong
  // (but lower-cost) rotation for symmetric shapes like rectangular blocks,
  // which would silently corrupt every adjacent zone's boundary.
  if (previousRing.length === nextRing.length) {
    return compareRings(previousRing, nextRing);
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
  const originalRing = stripClosingPosition(closedRing);
  let ring = originalRing;

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

  // Do not normalize a ring merely because it was inspected for a possible
  // shared-boundary edit. Imported boundary data can legitimately contain
  // redundant consecutive coordinates. Removing those coordinates from an
  // unrelated ring makes it look affected, which in turn causes every such
  // zone to be previewed and persisted even though it shares no edited edge.
  if (ringsEqual(originalRing, ring)) {
    return closedRing;
  }

  ring = removeConsecutiveDuplicates(ring);

  return ring.length > 0 ? [...ring, ring[0]] : closedRing;
}

function ringsEqual(left: Position[], right: Position[]): boolean {
  return left.length === right.length
    && left.every((position, index) => positionsEqual(position, right[index]));
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

// ── Adjacency gap detection & healing ───────────────────────────────────────
//
// Two zones can look adjacent on the map while their boundaries are actually
// a hair's-width apart — e.g. from manual drawing, or from snapping that
// landed close but not exact. `propagateSharedBoundaryEdit` only keeps
// *already-exact* shared vertices in sync; it can't heal a gap that was
// there from the start. These functions find that class of near-miss vertex
// clusters and, on request, merge each cluster onto a single shared point.

const METERS_PER_DEGREE_LAT = 111_320;

export interface AdjacencyGapVertex {
  zoneId: string;
  ringPath: string;
  vertexIndex: number;
  position: Position;
}

export interface AdjacencyGap {
  id: string;
  zoneIds: string[];
  vertices: AdjacencyGapVertex[];
  gapMeters: number;
  suggestedFix: Position;
}

export interface AdjacencyGapReport {
  gaps: AdjacencyGap[];
  toleranceMeters: number;
}

export interface AdjacencyGapVertexEdit {
  zoneId: string;
  ringPath: string;
  vertexIndex: number;
  position: Position;
}

export interface AdjacencyGapFix {
  gap: AdjacencyGap;
  edits: AdjacencyGapVertexEdit[];
}

export function findAdjacencyGaps(zones: BoundaryEditZone[], toleranceMeters: number): AdjacencyGapReport {
  const refs = zones.flatMap(collectZoneVertexRefs);
  const clusters = clusterNearbyVertices(refs, toleranceMeters);

  const gaps: AdjacencyGap[] = [];
  let gapCounter = 0;

  for (const members of clusters) {
    const zoneIds = Array.from(new Set(members.map((member) => member.zoneId)));
    if (zoneIds.length < 2) continue;

    const distinctPositions: Position[] = [];
    for (const member of members) {
      if (!distinctPositions.some((position) => positionsEqual(position, member.position))) {
        distinctPositions.push(member.position);
      }
    }
    if (distinctPositions.length <= 1) continue;

    gapCounter += 1;
    gaps.push({
      id: `gap-${gapCounter}`,
      zoneIds,
      vertices: members,
      gapMeters: maxPairwiseDistanceMeters(members.map((member) => member.position)),
      suggestedFix: pickCanonicalPosition(members),
    });
  }

  return { gaps, toleranceMeters };
}

/**
 * Plans a fix for each detected gap independently, as a list of vertex
 * edits per zone, rather than one combined geometry per zone. Applying gaps
 * one at a time (via `applyAdjacencyGapFix`) and validating after each lets
 * a caller skip a single bad fix without losing every other legitimate one —
 * important on a real map where one gap producing an invalid shape shouldn't
 * block the rest of a batch heal.
 */
export function planAdjacencyGapFixes(zones: BoundaryEditZone[], toleranceMeters: number): AdjacencyGapFix[] {
  const { gaps } = findAdjacencyGaps(zones, toleranceMeters);
  return gaps.map((gap) => ({
    gap,
    edits: gap.vertices
      .filter((vertex) => !positionsEqual(vertex.position, gap.suggestedFix))
      .map((vertex) => ({
        zoneId: vertex.zoneId,
        ringPath: vertex.ringPath,
        vertexIndex: vertex.vertexIndex,
        position: gap.suggestedFix,
      })),
  }));
}

export function applyAdjacencyGapFix(geometry: GeoJsonGeometry, edits: AdjacencyGapVertexEdit[]): GeoJsonGeometry {
  const byRing = new Map<string, Map<number, Position>>();
  for (const edit of edits) {
    const byVertex = byRing.get(edit.ringPath) ?? new Map<number, Position>();
    byRing.set(edit.ringPath, byVertex);
    byVertex.set(edit.vertexIndex, edit.position);
  }
  return applyVertexEdits(geometry, byRing);
}

function collectZoneVertexRefs(zone: BoundaryEditZone): AdjacencyGapVertex[] {
  const refs: AdjacencyGapVertex[] = [];
  const visitRing = (ring: Position[], ringPath: string) => {
    stripClosingPosition(ring).forEach((position, vertexIndex) => {
      refs.push({ zoneId: zone.id, ringPath, vertexIndex, position });
    });
  };

  if (zone.geometry.type === 'Polygon') {
    (zone.geometry.coordinates as Position[][]).forEach((ring, ringIndex) => visitRing(ring, `${ringIndex}`));
  } else if (zone.geometry.type === 'MultiPolygon') {
    (zone.geometry.coordinates as Position[][][]).forEach((polygon, polygonIndex) => {
      polygon.forEach((ring, ringIndex) => visitRing(ring, `${polygonIndex}.${ringIndex}`));
    });
  }

  return refs;
}

/**
 * Groups nearby cross-zone vertices using diameter-bounded (complete-linkage)
 * clustering: two clusters only merge if EVERY member of one is within
 * tolerance of EVERY member of the other. Plain single-linkage (union-find
 * on any pair within tolerance) lets clusters "chain" — A near B near C
 * merges A with C even if A and C are farther apart than the tolerance —
 * which on a dense real-world map merges unrelated vertices from different
 * zones and corrupts their shapes. Requiring every pairwise distance to stay
 * within tolerance keeps each cluster a genuine single point of contact.
 */
function clusterNearbyVertices(refs: AdjacencyGapVertex[], toleranceMeters: number): AdjacencyGapVertex[][] {
  let nextClusterId = 0;
  const clusters = new Map<number, number[]>();
  const clusterOf = new Map<number, number>();
  refs.forEach((_ref, index) => {
    const id = nextClusterId;
    nextClusterId += 1;
    clusters.set(id, [index]);
    clusterOf.set(index, id);
  });

  const candidates: Array<{ i: number; j: number; distance: number }> = [];
  for (let i = 0; i < refs.length; i += 1) {
    for (let j = i + 1; j < refs.length; j += 1) {
      if (refs[i].zoneId === refs[j].zoneId) continue;
      const distance = metersBetween(refs[i].position, refs[j].position);
      if (distance <= toleranceMeters) candidates.push({ i, j, distance });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);

  for (const { i, j } of candidates) {
    const clusterIId = clusterOf.get(i)!;
    const clusterJId = clusterOf.get(j)!;
    if (clusterIId === clusterJId) continue;

    const clusterI = clusters.get(clusterIId)!;
    const clusterJ = clusters.get(clusterJId)!;

    let canMerge = true;
    outer:
    for (const a of clusterI) {
      for (const b of clusterJ) {
        if (metersBetween(refs[a].position, refs[b].position) > toleranceMeters) {
          canMerge = false;
          break outer;
        }
      }
    }
    if (!canMerge) continue;

    clusters.set(clusterIId, clusterI.concat(clusterJ));
    clusters.delete(clusterJId);
    for (const memberIndex of clusterJ) clusterOf.set(memberIndex, clusterIId);
  }

  return Array.from(clusters.values()).map((memberIndices) => memberIndices.map((index) => refs[index]));
}

function pickCanonicalPosition(members: AdjacencyGapVertex[]): Position {
  const counts = new Map<string, { count: number; position: Position }>();
  for (const member of members) {
    const key = `${member.position[0].toFixed(9)},${member.position[1].toFixed(9)}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { count: 1, position: member.position });
  }

  let majority: { count: number; position: Position } | null = null;
  for (const entry of counts.values()) {
    if (!majority || entry.count > majority.count) majority = entry;
  }
  if (majority && majority.count > 1) return majority.position;

  const sum = members.reduce<Position>((acc, member) => [acc[0] + member.position[0], acc[1] + member.position[1]], [0, 0]);
  return [sum[0] / members.length, sum[1] / members.length];
}

function applyVertexEdits(geometry: GeoJsonGeometry, byRing: Map<string, Map<number, Position>>): GeoJsonGeometry {
  if (geometry.type === 'Polygon') {
    return {
      ...geometry,
      coordinates: (geometry.coordinates as Position[][]).map(
        (ring, ringIndex) => applyRingVertexEdits(ring, byRing.get(`${ringIndex}`)),
      ),
    };
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      ...geometry,
      coordinates: (geometry.coordinates as Position[][][]).map(
        (polygon, polygonIndex) => polygon.map(
          (ring, ringIndex) => applyRingVertexEdits(ring, byRing.get(`${polygonIndex}.${ringIndex}`)),
        ),
      ),
    };
  }
  return geometry;
}

function applyRingVertexEdits(closedRing: Position[], edits: Map<number, Position> | undefined): Position[] {
  if (!edits) return closedRing.map(copyPosition);
  const ring = stripClosingPosition(closedRing).map((position, index) => {
    const replacement = edits.get(index);
    return replacement ? copyPosition(replacement) : position;
  });
  return [...ring, ring[0]];
}

function maxPairwiseDistanceMeters(positions: Position[]): number {
  let max = 0;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      max = Math.max(max, metersBetween(positions[i], positions[j]));
    }
  }
  return max;
}

function metersBetween(a: Position, b: Position): number {
  const latRad = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos(latRad);
  const dx = (b[0] - a[0]) * metersPerDegreeLng;
  const dy = (b[1] - a[1]) * METERS_PER_DEGREE_LAT;
  return Math.hypot(dx, dy);
}
