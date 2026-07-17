import type { GeoJsonGeometry } from './types.js';

type Position = [number, number];

/**
 * A shared-node ("topology") view of a set of zone polygons.
 *
 * Instead of every zone owning private copies of its boundary coordinates,
 * every distinct vertex position on the map becomes a single numbered node,
 * and each zone ring is a sequence of node ids. Two zones that share a
 * boundary reference the *same* node ids along it, so moving a node reshapes
 * every zone that touches it — gaps and overlaps along shared boundaries
 * become unrepresentable rather than merely discouraged.
 *
 * The graph is a plain JSON-serializable value so editors can snapshot it
 * for undo history with a structured clone.
 */
export interface ZoneGraph {
  /** Node positions indexed by node id. Orphaned ids may remain after edits. */
  positions: Position[];
  zones: ZoneGraphZone[];
}

export interface ZoneGraphZone {
  zoneId: string;
  geometryType: 'Polygon' | 'MultiPolygon';
  /** polygons[polygonIndex][ringIndex] = open ring of node ids (no closing duplicate). */
  polygons: number[][][];
}

export interface ZoneGraphBuildResult {
  graph: ZoneGraph;
  /** Zones whose geometry was not polygonal (or degenerate) and is not represented in the graph. */
  skippedZoneIds: string[];
}

export interface ZoneGraphEdge {
  a: number;
  b: number;
}

export interface GraphZoneInput {
  id: string;
  geometry: GeoJsonGeometry;
}

const METERS_PER_DEGREE_LAT = 111_320;
export const DEFAULT_WELD_TOLERANCE_METERS = 0.1;

// ── Build ────────────────────────────────────────────────────────────────────

export function buildZoneGraph(
  zones: GraphZoneInput[],
  toleranceMeters: number = DEFAULT_WELD_TOLERANCE_METERS,
): ZoneGraphBuildResult {
  const skippedZoneIds: string[] = [];
  const polygonal = zones.filter((zone) => {
    if (zone.geometry.type === 'Polygon' || zone.geometry.type === 'MultiPolygon') return true;
    skippedZoneIds.push(zone.id);
    return false;
  });

  // 1. Collect every vertex of every ring.
  interface VertexRef { position: Position }
  const refs: VertexRef[] = [];
  const ringRefs: Array<{ zoneIndex: number; polygonIndex: number; ringIndex: number; refIndices: number[] }> = [];

  polygonal.forEach((zone, zoneIndex) => {
    const polygons = zone.geometry.type === 'Polygon'
      ? [zone.geometry.coordinates as Position[][]]
      : (zone.geometry.coordinates as Position[][][]);
    polygons.forEach((polygon, polygonIndex) => {
      polygon.forEach((ring, ringIndex) => {
        const open = stripClosingPosition(ring);
        const refIndices = open.map((position) => {
          refs.push({ position: [position[0], position[1]] });
          return refs.length - 1;
        });
        ringRefs.push({ zoneIndex, polygonIndex, ringIndex, refIndices });
      });
    });
  });

  // 2. Weld vertices within tolerance into shared nodes (grid + union-find).
  const nodeOfRef = clusterVertices(refs.map((ref) => ref.position), toleranceMeters);
  const nodeCount = nodeOfRef.length === 0 ? 0 : Math.max(...nodeOfRef) + 1;
  const positions: Position[] = new Array<Position>(nodeCount);
  for (let refIndex = 0; refIndex < refs.length; refIndex += 1) {
    const nodeId = nodeOfRef[refIndex];
    if (positions[nodeId] === undefined) {
      positions[nodeId] = refs[refIndex].position;
    }
  }

  // 3. Assemble zone rings as node-id sequences.
  const graphZones: ZoneGraphZone[] = polygonal.map((zone) => ({
    zoneId: zone.id,
    geometryType: zone.geometry.type as 'Polygon' | 'MultiPolygon',
    polygons: [],
  }));
  const degenerateZoneIndices = new Set<number>();

  for (const ringRef of ringRefs) {
    const nodeIds = dedupeRing(ringRef.refIndices.map((refIndex) => nodeOfRef[refIndex]));
    if (nodeIds.length < 3) {
      degenerateZoneIndices.add(ringRef.zoneIndex);
      continue;
    }
    const zone = graphZones[ringRef.zoneIndex];
    while (zone.polygons.length <= ringRef.polygonIndex) zone.polygons.push([]);
    zone.polygons[ringRef.polygonIndex].push(nodeIds);
  }

  const graph: ZoneGraph = {
    positions,
    zones: graphZones.filter((zone, index) => {
      const degenerate = degenerateZoneIndices.has(index)
        || zone.polygons.length === 0
        || zone.polygons.some((polygon) => polygon.length === 0);
      if (degenerate) skippedZoneIds.push(zone.zoneId);
      return !degenerate;
    }),
  };

  // 4. Convert T-junctions into true shared nodes: any node that lies on the
  //    interior of another ring's segment gets inserted into that segment, so
  //    the junction is represented identically in every zone that meets there.
  insertTJunctionNodes(graph, toleranceMeters);

  return { graph, skippedZoneIds };
}

/**
 * Groups vertex positions within `toleranceMeters` of each other and returns,
 * for each input index, the id of the node it welds into. Node ids are dense
 * (0..n-1). Uses a spatial grid so clustering stays near-linear.
 */
function clusterVertices(positions: Position[], toleranceMeters: number): number[] {
  const parent = positions.map((_position, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  const grid = buildGrid(positions, toleranceMeters);
  for (let index = 0; index < positions.length; index += 1) {
    for (const otherIndex of grid.nearby(positions[index])) {
      if (otherIndex <= index) continue;
      if (metersBetween(positions[index], positions[otherIndex]) <= toleranceMeters) {
        union(index, otherIndex);
      }
    }
  }

  const nodeIdOfRoot = new Map<number, number>();
  return positions.map((_position, index) => {
    const root = find(index);
    let nodeId = nodeIdOfRoot.get(root);
    if (nodeId === undefined) {
      nodeId = nodeIdOfRoot.size;
      nodeIdOfRoot.set(root, nodeId);
    }
    return nodeId;
  });
}

interface SpatialGrid {
  nearby(position: Position): number[];
}

function buildGrid(positions: Position[], toleranceMeters: number): SpatialGrid {
  const referenceLat = positions.length > 0 ? positions[0][1] : 0;
  const cellLat = Math.max(toleranceMeters / METERS_PER_DEGREE_LAT, 1e-12);
  const latCos = Math.max(Math.abs(Math.cos((referenceLat * Math.PI) / 180)), 0.01);
  const cellLng = Math.max(toleranceMeters / (METERS_PER_DEGREE_LAT * latCos), 1e-12);

  const cells = new Map<string, number[]>();
  const keyOf = (position: Position) => `${Math.floor(position[0] / cellLng)}:${Math.floor(position[1] / cellLat)}`;
  positions.forEach((position, index) => {
    const key = keyOf(position);
    const bucket = cells.get(key);
    if (bucket) bucket.push(index);
    else cells.set(key, [index]);
  });

  return {
    nearby(position: Position): number[] {
      const cellX = Math.floor(position[0] / cellLng);
      const cellY = Math.floor(position[1] / cellLat);
      const found: number[] = [];
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const bucket = cells.get(`${cellX + dx}:${cellY + dy}`);
          if (bucket) found.push(...bucket);
        }
      }
      return found;
    },
  };
}

function insertTJunctionNodes(graph: ZoneGraph, toleranceMeters: number): void {
  const grid = buildGrid(graph.positions, toleranceMeters);

  for (const zone of graph.zones) {
    for (const polygon of zone.polygons) {
      for (const ring of polygon) {
        // Rings mutate while we scan, so walk by index and re-read length.
        for (let index = 0; index < ring.length; index += 1) {
          const aId = ring[index];
          const bId = ring[(index + 1) % ring.length];
          const insertions = findNodesOnSegment(graph, grid, ring, aId, bId, toleranceMeters);
          if (insertions.length === 0) continue;
          ring.splice(index + 1, 0, ...insertions);
          index += insertions.length;
        }
      }
    }
  }
}

/** Node ids lying strictly inside segment a→b (sorted along it), excluding ids already in the ring. */
function findNodesOnSegment(
  graph: ZoneGraph,
  grid: SpatialGrid,
  ring: number[],
  aId: number,
  bId: number,
  toleranceMeters: number,
): number[] {
  const a = graph.positions[aId];
  const b = graph.positions[bId];
  const ringMembers = new Set(ring);
  const candidates = new Map<number, number>(); // nodeId -> projection t

  const searchPoints = interpolateSegment(a, b, toleranceMeters);
  const seen = new Set<number>();
  for (const searchPoint of searchPoints) {
    for (const nodeId of grid.nearby(searchPoint)) {
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      if (nodeId === aId || nodeId === bId || ringMembers.has(nodeId)) continue;
      const position = graph.positions[nodeId];
      if (position === undefined) continue;
      const projection = projectOntoSegment(position, a, b);
      if (projection.t <= 0 || projection.t >= 1) continue;
      if (metersBetween(position, projection.point) > toleranceMeters) continue;
      // Only weld nodes near the segment's interior, not near its endpoints —
      // endpoint-adjacent matches are the vertex-weld step's job.
      if (metersBetween(position, a) <= toleranceMeters || metersBetween(position, b) <= toleranceMeters) continue;
      candidates.set(nodeId, projection.t);
    }
  }

  return Array.from(candidates.entries())
    .sort((left, right) => left[1] - right[1])
    .map(([nodeId]) => nodeId);
}

/** Sample points along a segment at ~tolerance spacing so a grid query covers its whole length. */
function interpolateSegment(a: Position, b: Position, toleranceMeters: number): Position[] {
  const lengthMeters = metersBetween(a, b);
  const steps = Math.min(Math.max(Math.ceil(lengthMeters / Math.max(toleranceMeters, 0.01)), 1), 4096);
  const points: Position[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    points.push([a[0] + ((b[0] - a[0]) * t), a[1] + ((b[1] - a[1]) * t)]);
  }
  return points;
}

// ── Editing operations ──────────────────────────────────────────────────────

export function moveGraphNodes(graph: ZoneGraph, updates: Map<number, Position>): void {
  for (const [nodeId, position] of updates) {
    if (graph.positions[nodeId] !== undefined) {
      graph.positions[nodeId] = [position[0], position[1]];
    }
  }
}

export interface DeleteNodesResult {
  ok: boolean;
  /** Zones whose rings would drop below three nodes. */
  blockedZoneIds: string[];
}

export function deleteGraphNodes(graph: ZoneGraph, nodeIds: Set<number>): DeleteNodesResult {
  const blockedZoneIds: string[] = [];
  for (const zone of graph.zones) {
    for (const polygon of zone.polygons) {
      for (const ring of polygon) {
        const remaining = dedupeRing(ring.filter((nodeId) => !nodeIds.has(nodeId)));
        if (remaining.length < 3 && remaining.length !== ring.length) {
          blockedZoneIds.push(zone.zoneId);
        }
      }
    }
  }
  if (blockedZoneIds.length > 0) {
    return { ok: false, blockedZoneIds: Array.from(new Set(blockedZoneIds)) };
  }

  for (const zone of graph.zones) {
    for (const polygon of zone.polygons) {
      for (let ringIndex = 0; ringIndex < polygon.length; ringIndex += 1) {
        polygon[ringIndex] = dedupeRing(polygon[ringIndex].filter((nodeId) => !nodeIds.has(nodeId)));
      }
    }
  }
  return { ok: true, blockedZoneIds: [] };
}

/**
 * Inserts a new node between nodes `a` and `b` in every ring where they are
 * adjacent (in either direction), so an edge shared by two zones gains the
 * node on both sides at once. Returns the new node id, or null if no ring
 * contains that edge.
 */
export function insertGraphNodeOnEdge(graph: ZoneGraph, aId: number, bId: number, position: Position): number | null {
  const nodeId = graph.positions.length;
  let inserted = false;

  for (const zone of graph.zones) {
    for (const polygon of zone.polygons) {
      for (const ring of polygon) {
        for (let index = 0; index < ring.length; index += 1) {
          const current = ring[index];
          const next = ring[(index + 1) % ring.length];
          if ((current === aId && next === bId) || (current === bId && next === aId)) {
            ring.splice(index + 1, 0, nodeId);
            inserted = true;
            break;
          }
        }
      }
    }
  }

  if (!inserted) return null;
  graph.positions.push([position[0], position[1]]);
  return nodeId;
}

export interface WeldResult {
  ok: boolean;
  reason?: string;
}

/**
 * Merges node `fromId` into node `intoId`: every ring reference to `fromId`
 * becomes `intoId`. Refused when a ring would end up visiting `intoId` twice
 * non-adjacently (a pinched ring) or would collapse below three nodes.
 */
export function weldGraphNodes(graph: ZoneGraph, fromId: number, intoId: number): WeldResult {
  if (fromId === intoId) return { ok: true };

  for (const zone of graph.zones) {
    for (const polygon of zone.polygons) {
      for (const ring of polygon) {
        if (!ring.includes(fromId)) continue;
        const replaced = dedupeRing(ring.map((nodeId) => (nodeId === fromId ? intoId : nodeId)));
        if (replaced.length < 3) {
          return { ok: false, reason: `"${zone.zoneId}" would collapse below three corners.` };
        }
        if (countOccurrences(replaced, intoId) > 1) {
          return { ok: false, reason: 'That would pinch a zone boundary into a figure-eight.' };
        }
      }
    }
  }

  for (const zone of graph.zones) {
    for (const polygon of zone.polygons) {
      for (let ringIndex = 0; ringIndex < polygon.length; ringIndex += 1) {
        if (!polygon[ringIndex].includes(fromId)) continue;
        polygon[ringIndex] = dedupeRing(polygon[ringIndex].map((nodeId) => (nodeId === fromId ? intoId : nodeId)));
      }
    }
  }
  return { ok: true };
}

/**
 * Snaps node `nodeId` onto the segment between `aId` and `bId` and inserts it
 * into every ring where that segment appears (except rings that already
 * contain the node — inserting there would pinch the ring).
 */
export function weldGraphNodeIntoEdge(graph: ZoneGraph, nodeId: number, aId: number, bId: number): WeldResult {
  if (nodeId === aId || nodeId === bId) return { ok: false, reason: 'Node is already an endpoint of that edge.' };
  const position = graph.positions[nodeId];
  const a = graph.positions[aId];
  const b = graph.positions[bId];
  if (!position || !a || !b) return { ok: false, reason: 'Unknown node.' };

  const projection = projectOntoSegment(position, a, b);
  graph.positions[nodeId] = projection.point;

  for (const zone of graph.zones) {
    for (const polygon of zone.polygons) {
      for (const ring of polygon) {
        if (ring.includes(nodeId)) continue;
        for (let index = 0; index < ring.length; index += 1) {
          const current = ring[index];
          const next = ring[(index + 1) % ring.length];
          if ((current === aId && next === bId) || (current === bId && next === aId)) {
            ring.splice(index + 1, 0, nodeId);
            break;
          }
        }
      }
    }
  }
  return { ok: true };
}

// ── Extraction & inspection ─────────────────────────────────────────────────

export function extractZoneGeometries(graph: ZoneGraph): Record<string, GeoJsonGeometry> {
  const geometries: Record<string, GeoJsonGeometry> = {};
  for (const zone of graph.zones) {
    const polygons = zone.polygons.map((polygon) => polygon.map((ring) => closeRing(
      ring.map((nodeId) => {
        const position = graph.positions[nodeId];
        return [position[0], position[1]] as Position;
      }),
    )));
    geometries[zone.zoneId] = zone.geometryType === 'Polygon'
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons };
  }
  return geometries;
}

/** Unique undirected edges across all rings. */
export function listGraphEdges(graph: ZoneGraph): ZoneGraphEdge[] {
  const seen = new Set<string>();
  const edges: ZoneGraphEdge[] = [];
  for (const zone of graph.zones) {
    for (const polygon of zone.polygons) {
      for (const ring of polygon) {
        for (let index = 0; index < ring.length; index += 1) {
          const a = ring[index];
          const b = ring[(index + 1) % ring.length];
          if (a === b) continue;
          const key = a < b ? `${a}:${b}` : `${b}:${a}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ a, b });
        }
      }
    }
  }
  return edges;
}

/** Node ids actually referenced by at least one ring. */
export function listGraphNodeIds(graph: ZoneGraph): number[] {
  const ids = new Set<number>();
  for (const zone of graph.zones) {
    for (const polygon of zone.polygons) {
      for (const ring of polygon) {
        for (const nodeId of ring) ids.add(nodeId);
      }
    }
  }
  return Array.from(ids);
}

/** Zone ids whose ring node ids reference any of the given nodes. */
export function zonesUsingGraphNodes(graph: ZoneGraph, nodeIds: Set<number>): string[] {
  const zoneIds: string[] = [];
  for (const zone of graph.zones) {
    const uses = zone.polygons.some((polygon) => polygon.some((ring) => ring.some((nodeId) => nodeIds.has(nodeId))));
    if (uses) zoneIds.push(zone.zoneId);
  }
  return zoneIds;
}

export function cloneZoneGraph(graph: ZoneGraph): ZoneGraph {
  return {
    positions: graph.positions.map((position) => [position[0], position[1]] as Position),
    zones: graph.zones.map((zone) => ({
      zoneId: zone.zoneId,
      geometryType: zone.geometryType,
      polygons: zone.polygons.map((polygon) => polygon.map((ring) => [...ring])),
    })),
  };
}

// ── Internals ────────────────────────────────────────────────────────────────

function stripClosingPosition(ring: Position[] | number[][]): Position[] {
  const typed = ring as Position[];
  if (typed.length > 1
    && typed[0][0] === typed[typed.length - 1][0]
    && typed[0][1] === typed[typed.length - 1][1]) {
    return typed.slice(0, -1);
  }
  return typed.slice();
}

function closeRing(ring: Position[]): Position[] {
  return ring.length > 0 ? [...ring, [ring[0][0], ring[0][1]]] : ring;
}

/** Removes consecutive duplicate node ids, including across the ring wrap-around. */
function dedupeRing(ring: number[]): number[] {
  const result = ring.filter((nodeId, index) => index === 0 || nodeId !== ring[index - 1]);
  while (result.length > 1 && result[0] === result[result.length - 1]) result.pop();
  return result;
}

function countOccurrences(ring: number[], nodeId: number): number {
  return ring.reduce((count, candidate) => (candidate === nodeId ? count + 1 : count), 0);
}

function projectOntoSegment(point: Position, a: Position, b: Position): { point: Position; t: number } {
  const segmentLng = b[0] - a[0];
  const segmentLat = b[1] - a[1];
  const lengthSquared = (segmentLng * segmentLng) + (segmentLat * segmentLat);
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, (((point[0] - a[0]) * segmentLng) + ((point[1] - a[1]) * segmentLat)) / lengthSquared));
  return { point: [a[0] + (segmentLng * t), a[1] + (segmentLat * t)], t };
}

function metersBetween(a: Position, b: Position): number {
  const latRad = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos(latRad);
  const dx = (b[0] - a[0]) * metersPerDegreeLng;
  const dy = (b[1] - a[1]) * METERS_PER_DEGREE_LAT;
  return Math.hypot(dx, dy);
}
