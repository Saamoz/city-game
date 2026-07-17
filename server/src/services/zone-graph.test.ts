import { describe, expect, it } from 'vitest';
import {
  buildZoneGraph,
  deleteGraphNodes,
  extractZoneGeometries,
  graphSnapCreatesIntersections,
  insertGraphNodeOnEdge,
  listGraphEdges,
  listGraphNodeIds,
  moveGraphNodes,
  weldGraphNodeIntoEdge,
  weldGraphNodes,
  zonesUsingGraphNodes,
  type GeoJsonGeometry,
} from '@city-game/shared';

function polygon(positions: Array<[number, number]>): GeoJsonGeometry {
  return {
    type: 'Polygon',
    coordinates: [[...positions, positions[0]]],
  };
}

function rectangle(minLng: number, minLat: number, maxLng: number, maxLat: number): GeoJsonGeometry {
  return polygon([
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
  ]);
}

function ringOf(geometry: GeoJsonGeometry): Array<[number, number]> {
  if (geometry.type !== 'Polygon') throw new Error('expected polygon');
  return geometry.coordinates[0] as Array<[number, number]>;
}

describe('buildZoneGraph', () => {
  it('welds exactly shared boundary vertices into single nodes', () => {
    const { graph, skippedZoneIds } = buildZoneGraph([
      { id: 'left', geometry: rectangle(0, 0, 1, 1) },
      { id: 'right', geometry: rectangle(1, 0, 2, 1) },
    ]);

    expect(skippedZoneIds).toEqual([]);
    // 8 corners minus 2 shared = 6 distinct nodes.
    expect(listGraphNodeIds(graph)).toHaveLength(6);

    const geometries = extractZoneGeometries(graph);
    expect(ringOf(geometries.left)).toEqual(ringOf(rectangle(0, 0, 1, 1)));
    expect(ringOf(geometries.right)).toEqual(ringOf(rectangle(1, 0, 2, 1)));
  });

  it('welds near-coincident vertices (hairline gaps) into one node', () => {
    const nudge = 0.0000002; // ~2cm
    const { graph } = buildZoneGraph([
      { id: 'left', geometry: rectangle(0, 0, 1, 1) },
      {
        id: 'right',
        geometry: polygon([
          [1 + nudge, 0],
          [2, 0],
          [2, 1],
          [1, 1 + nudge],
        ]),
      },
    ]);

    expect(listGraphNodeIds(graph)).toHaveLength(6);
    const geometries = extractZoneGeometries(graph);
    // After welding, the shared corners have identical coordinates in both zones.
    const leftRing = ringOf(geometries.left);
    const rightRing = ringOf(geometries.right);
    for (const shared of [leftRing[1], leftRing[2]]) {
      expect(rightRing.some(([lng, lat]) => lng === shared[0] && lat === shared[1])).toBe(true);
    }
  });

  it('converts T-junctions into true shared nodes', () => {
    // Two stacked squares on the left, one tall rectangle on the right.
    // The right rectangle's edge passes through the junction at (1, 1).
    const { graph } = buildZoneGraph([
      { id: 'lower-left', geometry: rectangle(0, 0, 1, 1) },
      { id: 'upper-left', geometry: rectangle(0, 1, 1, 2) },
      { id: 'right', geometry: rectangle(1, 0, 2, 2) },
    ]);

    const geometries = extractZoneGeometries(graph);
    const rightRing = ringOf(geometries.right);
    // The junction node (1,1) must now be part of the right rectangle's ring.
    expect(rightRing.some(([lng, lat]) => lng === 1 && lat === 1)).toBe(true);

    // Moving the junction reshapes all three zones.
    const junctionId = listGraphNodeIds(graph).find((nodeId) => {
      const [lng, lat] = graph.positions[nodeId];
      return lng === 1 && lat === 1;
    });
    expect(junctionId).toBeDefined();
    moveGraphNodes(graph, new Map([[junctionId!, [1.25, 1.1]]]));

    const moved = extractZoneGeometries(graph);
    for (const zoneId of ['lower-left', 'upper-left', 'right']) {
      expect(ringOf(moved[zoneId]).some(([lng, lat]) => lng === 1.25 && lat === 1.1)).toBe(true);
    }
    expect(zonesUsingGraphNodes(graph, new Set([junctionId!]))).toEqual(['lower-left', 'upper-left', 'right']);
  });

  it('skips point zones and reports them', () => {
    const { graph, skippedZoneIds } = buildZoneGraph([
      { id: 'area', geometry: rectangle(0, 0, 1, 1) },
      { id: 'station', geometry: { type: 'Point', coordinates: [5, 5] } },
    ]);
    expect(skippedZoneIds).toEqual(['station']);
    expect(graph.zones.map((zone) => zone.zoneId)).toEqual(['area']);
  });
});

describe('graph editing operations', () => {
  it('moving a shared node reshapes both zones identically', () => {
    const { graph } = buildZoneGraph([
      { id: 'left', geometry: rectangle(0, 0, 1, 1) },
      { id: 'right', geometry: rectangle(1, 0, 2, 1) },
    ]);
    const sharedTop = listGraphNodeIds(graph).find((nodeId) => {
      const [lng, lat] = graph.positions[nodeId];
      return lng === 1 && lat === 1;
    })!;

    moveGraphNodes(graph, new Map([[sharedTop, [1.3, 1.2]]]));
    const geometries = extractZoneGeometries(graph);
    expect(ringOf(geometries.left).some(([lng, lat]) => lng === 1.3 && lat === 1.2)).toBe(true);
    expect(ringOf(geometries.right).some(([lng, lat]) => lng === 1.3 && lat === 1.2)).toBe(true);
  });

  it('inserts a node into a shared edge on both sides', () => {
    const { graph } = buildZoneGraph([
      { id: 'left', geometry: rectangle(0, 0, 1, 1) },
      { id: 'right', geometry: rectangle(1, 0, 2, 1) },
    ]);
    const bottom = findNode(graph.positions, 1, 0);
    const top = findNode(graph.positions, 1, 1);

    const inserted = insertGraphNodeOnEdge(graph, bottom, top, [1, 0.5]);
    expect(inserted).not.toBeNull();

    const geometries = extractZoneGeometries(graph);
    expect(ringOf(geometries.left).some(([lng, lat]) => lng === 1 && lat === 0.5)).toBe(true);
    expect(ringOf(geometries.right).some(([lng, lat]) => lng === 1 && lat === 0.5)).toBe(true);

    // Both rings gained exactly one vertex (5 corners -> 6 ring entries with closer).
    expect(ringOf(geometries.left)).toHaveLength(6);
    expect(ringOf(geometries.right)).toHaveLength(6);
  });

  it('deletes a shared node from every ring, refusing when a ring would degenerate', () => {
    const { graph } = buildZoneGraph([
      { id: 'left', geometry: rectangle(0, 0, 1, 1) },
      { id: 'right', geometry: rectangle(1, 0, 2, 1) },
    ]);
    const bottom = findNode(graph.positions, 1, 0);
    const top = findNode(graph.positions, 1, 1);
    const inserted = insertGraphNodeOnEdge(graph, bottom, top, [1, 0.5])!;

    expect(deleteGraphNodes(graph, new Set([inserted])).ok).toBe(true);
    const geometries = extractZoneGeometries(graph);
    expect(ringOf(geometries.left)).toHaveLength(5);
    expect(ringOf(geometries.right)).toHaveLength(5);

    // Deleting two corners of a square would leave 2 nodes -> refused.
    const cornerA = findNode(graph.positions, 0, 0);
    const cornerB = findNode(graph.positions, 0, 1);
    const refused = deleteGraphNodes(graph, new Set([cornerA, cornerB]));
    expect(refused.ok).toBe(false);
    expect(refused.blockedZoneIds).toEqual(['left']);
  });

  it('welds one node into another across all zones', () => {
    const { graph } = buildZoneGraph([
      { id: 'left', geometry: rectangle(0, 0, 1, 1) },
      { id: 'right', geometry: rectangle(1, 0, 2, 1) },
    ]);
    const bottom = findNode(graph.positions, 1, 0);
    const inserted = insertGraphNodeOnEdge(graph, bottom, findNode(graph.positions, 1, 1), [1, 0.5])!;

    const result = weldGraphNodes(graph, inserted, bottom);
    expect(result.ok).toBe(true);
    const geometries = extractZoneGeometries(graph);
    expect(ringOf(geometries.left)).toHaveLength(5);
    expect(ringOf(geometries.right)).toHaveLength(5);
  });

  it('welds a node into a foreign edge so a boundary becomes shared', () => {
    // Separate zones: right zone's left edge from (1,0) to (1,1); left zone has
    // a stray node near that edge at (0.999, 0.5) — weld it in.
    const { graph } = buildZoneGraph([
      {
        id: 'left',
        geometry: polygon([
          [0, 0],
          [1, 0],
          [0.999, 0.5],
          [1, 1],
          [0, 1],
        ]),
      },
      { id: 'right', geometry: rectangle(1, 0, 2, 1) },
    ]);
    const stray = findNode(graph.positions, 0.999, 0.5);
    const a = findNode(graph.positions, 1, 0);
    const b = findNode(graph.positions, 1, 1);

    const result = weldGraphNodeIntoEdge(graph, stray, a, b);
    expect(result.ok).toBe(true);

    const geometries = extractZoneGeometries(graph);
    const leftRing = ringOf(geometries.left);
    const rightRing = ringOf(geometries.right);
    const welded = leftRing.find(([lng, lat]) => lat === 0.5 && lng === 1);
    expect(welded).toBeDefined();
    expect(rightRing.some(([lng, lat]) => lng === welded![0] && lat === welded![1])).toBe(true);
  });

  it('detects when a straight edge snap would cross a wavy boundary nearby', () => {
    const movingZone = polygon([
      [-2, -1],
      [-0.1, 0],
      [-2, 1],
    ]);

    const { graph: cleanGraph } = buildZoneGraph([
      { id: 'moving', geometry: movingZone },
      { id: 'target', geometry: rectangle(0, -1, 2, 1) },
    ]);
    const cleanDragged = findNode(cleanGraph.positions, -0.1, 0);
    const cleanBottom = findNode(cleanGraph.positions, 0, -1);
    const cleanTop = findNode(cleanGraph.positions, 0, 1);

    expect(graphSnapCreatesIntersections(
      cleanGraph,
      cleanDragged,
      [0, 0],
      { type: 'edge', edge: { a: cleanBottom, b: cleanTop } },
    )).toBe(false);

    const { graph: wavyGraph } = buildZoneGraph([
      { id: 'moving', geometry: movingZone },
      {
        id: 'target',
        geometry: polygon([
          [0, -1],
          [2, -1],
          [2, 1],
          [0, 1],
          [-0.5, 0.1],
          [0, 0.2],
          [0, -0.2],
          [-0.5, -0.1],
        ]),
      },
    ]);
    const wavyDragged = findNode(wavyGraph.positions, -0.1, 0);
    const wavyBottom = findNode(wavyGraph.positions, 0, -0.2);
    const wavyTop = findNode(wavyGraph.positions, 0, 0.2);

    expect(graphSnapCreatesIntersections(
      wavyGraph,
      wavyDragged,
      [0, 0],
      { type: 'edge', edge: { a: wavyBottom, b: wavyTop } },
    )).toBe(true);
  });

  it('heals a folded three-zone junction by following the captured Chicago boundary', () => {
    const boundary: Array<[number, number]> = [
      [-87.633889, 41.903862],
      [-87.633648, 41.903866],
      [-87.633181, 41.903873],
      [-87.633002, 41.903877],
      [-87.632921, 41.903878],
      [-87.632847, 41.90388],
      [-87.632635, 41.903884],
      [-87.632196, 41.903889],
      [-87.631957, 41.903892],
      [-87.631445, 41.903901],
    ];
    const targetStart = boundary[0];
    const targetEnd = boundary[1];
    const oldJunction = boundary[boundary.length - 1];
    const lowerJunction: [number, number] = [oldJunction[0], 41.901];

    const { graph } = buildZoneGraph([
      {
        id: 'old-town',
        geometry: polygon([
          targetStart,
          [targetStart[0], 41.905],
          [oldJunction[0], 41.905],
          oldJunction,
          ...boundary.slice(1, -1).reverse(),
        ]),
      },
      {
        id: 'river-north',
        geometry: polygon([...boundary, lowerJunction, [targetStart[0], lowerJunction[1]]]),
      },
      {
        id: 'rush-division',
        geometry: polygon([
          oldJunction,
          [-87.6295, oldJunction[1]],
          [-87.6295, lowerJunction[1]],
          lowerJunction,
        ]),
      },
    ]);

    const oldJunctionId = findNode(graph.positions, ...oldJunction);
    const lowerJunctionId = findNode(graph.positions, ...lowerJunction);
    const targetStartId = findNode(graph.positions, ...targetStart);
    const targetEndId = findNode(graph.positions, ...targetEnd);
    const movingId = insertGraphNodeOnEdge(graph, oldJunctionId, lowerJunctionId, [oldJunction[0], 41.9035])!;
    const failedSnapPoint: [number, number] = [-87.63382360229195, 41.903863768400754];
    moveGraphNodes(graph, new Map([[movingId, failedSnapPoint]]));

    expect(graphSnapCreatesIntersections(
      graph,
      movingId,
      failedSnapPoint,
      { type: 'edge', edge: { a: targetStartId, b: targetEndId } },
    )).toBe(true);

    expect(weldGraphNodeIntoEdge(graph, movingId, targetStartId, targetEndId)).toMatchObject({
      ok: true,
      healedRingCount: 1,
    });
    expect(edgeUseCount(graph, targetStartId, movingId)).toBe(2);
    expect(edgeUseCount(graph, movingId, targetEndId)).toBe(2);
    expect(edgeUseCount(graph, movingId, lowerJunctionId)).toBe(2);

    const healed = extractZoneGeometries(graph);
    expect(ringOf(healed['river-north'])).not.toContainEqual(oldJunction);
    expect(ringOf(healed['rush-division'])).toContainEqual(targetEnd);
    expect(ringOf(healed['old-town'])).toContainEqual(graph.positions[movingId]);
  });

  it('lists unique undirected edges', () => {
    const { graph } = buildZoneGraph([
      { id: 'left', geometry: rectangle(0, 0, 1, 1) },
      { id: 'right', geometry: rectangle(1, 0, 2, 1) },
    ]);
    // 4 + 4 edges with 1 shared = 7 unique.
    expect(listGraphEdges(graph)).toHaveLength(7);
  });
});

function findNode(positions: Array<[number, number]>, lng: number, lat: number): number {
  const index = positions.findIndex((position) => position !== undefined && position[0] === lng && position[1] === lat);
  if (index < 0) throw new Error(`no node at ${lng},${lat}`);
  return index;
}

function edgeUseCount(
  graph: ReturnType<typeof buildZoneGraph>['graph'],
  aId: number,
  bId: number,
): number {
  let count = 0;
  for (const zone of graph.zones) {
    for (const polygon of zone.polygons) {
      for (const ring of polygon) {
        for (let index = 0; index < ring.length; index += 1) {
          const a = ring[index];
          const b = ring[(index + 1) % ring.length];
          if ((a === aId && b === bId) || (a === bId && b === aId)) count += 1;
        }
      }
    }
  }
  return count;
}
