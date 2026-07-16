import { describe, expect, it } from 'vitest';
import { propagateSharedBoundaryEdit, type GeoJsonGeometry } from '@city-game/shared';

describe('shared zone boundary editing', () => {
  it('moves matching vertices in the adjacent zone', () => {
    const left = rectangle(0, 0, 1, 1);
    const right = rectangle(1, 0, 2, 1);
    const editedLeft = polygon([
      [0, 0],
      [1.2, 0],
      [1.2, 1],
      [0, 1],
    ]);

    const result = propagateSharedBoundaryEdit('left', left, editedLeft, [
      { id: 'left', geometry: left },
      { id: 'right', geometry: right },
    ]);

    expect(result.affectedZoneIds).toEqual(['left', 'right']);
    expect(result.geometries.right).toEqual(polygon([
      [1.2, 0],
      [2, 0],
      [2, 1],
      [1.2, 1],
    ]));
  });

  it('inserts a new shared vertex into the adjacent boundary', () => {
    const left = rectangle(0, 0, 1, 1);
    const right = rectangle(1, 0, 2, 1);
    const editedLeft = polygon([
      [0, 0],
      [1, 0],
      [1.2, 0.5],
      [1, 1],
      [0, 1],
    ]);

    const result = propagateSharedBoundaryEdit('left', left, editedLeft, [
      { id: 'left', geometry: left },
      { id: 'right', geometry: right },
    ]);

    expect(result.geometries.right).toEqual(polygon([
      [1, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1.2, 0.5],
    ]));
  });

  it('moves a shared junction in every zone that references it', () => {
    const lowerLeft = rectangle(0, 0, 1, 1);
    const lowerRight = rectangle(1, 0, 2, 1);
    const upper = rectangle(0, 1, 2, 2);
    const editedLowerLeft = polygon([
      [0, 0],
      [1, 0],
      [1.1, 1.1],
      [0, 1],
    ]);

    const result = propagateSharedBoundaryEdit('lower-left', lowerLeft, editedLowerLeft, [
      { id: 'lower-left', geometry: lowerLeft },
      { id: 'lower-right', geometry: lowerRight },
      { id: 'upper', geometry: upper },
    ]);

    expect(result.geometries['lower-right']).toEqual(polygon([
      [1, 0],
      [2, 0],
      [2, 1],
      [1.1, 1.1],
    ]));
    expect(result.geometries.upper).toEqual(polygon([
      [0, 1],
      [1.1, 1.1],
      [2, 1],
      [2, 2],
      [0, 2],
    ]));
  });

  it('keeps index correspondence for a large single-vertex move instead of searching for a lower-cost rotation', () => {
    const left = rectangle(0, 0, 1, 1);
    const right = rectangle(1, 0, 2, 1);
    const editedLeft = polygon([
      [0, 0],
      [1, 0],
      [5, 5],
      [0, 1],
    ]);

    const result = propagateSharedBoundaryEdit('left', left, editedLeft, [
      { id: 'left', geometry: left },
      { id: 'right', geometry: right },
    ]);

    expect(result.geometries.right).toEqual(polygon([
      [1, 0],
      [2, 0],
      [2, 1],
      [5, 5],
    ]));
  });

  it('removes a deleted shared vertex from the adjacent boundary', () => {
    const left = polygon([
      [0, 0],
      [1, 0],
      [1.2, 0.5],
      [1, 1],
      [0, 1],
    ]);
    const right = polygon([
      [1, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1.2, 0.5],
    ]);
    const editedLeft = rectangle(0, 0, 1, 1);

    const result = propagateSharedBoundaryEdit('left', left, editedLeft, [
      { id: 'left', geometry: left },
      { id: 'right', geometry: right },
    ]);

    expect(result.geometries.right).toEqual(rectangle(1, 0, 2, 1));
  });

  it('does not normalize or affect unrelated zones with redundant coordinates', () => {
    const left = rectangle(0, 0, 1, 1);
    const right = rectangle(1, 0, 2, 1);
    const unrelated = polygon([
      [10, 10],
      [11, 10],
      [11, 10],
      [11, 11],
      [10, 11],
    ]);
    const editedLeft = polygon([
      [0, 0],
      [1.2, 0],
      [1.2, 1],
      [0, 1],
    ]);

    const result = propagateSharedBoundaryEdit('left', left, editedLeft, [
      { id: 'left', geometry: left },
      { id: 'right', geometry: right },
      { id: 'unrelated', geometry: unrelated },
    ]);

    expect(result.affectedZoneIds).toEqual(['left', 'right']);
    expect(result.geometries.unrelated).toBeUndefined();
    expect(unrelated).toEqual(polygon([
      [10, 10],
      [11, 10],
      [11, 10],
      [11, 11],
      [10, 11],
    ]));
  });
});

function rectangle(minLng: number, minLat: number, maxLng: number, maxLat: number): GeoJsonGeometry {
  return polygon([
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
  ]);
}

function polygon(positions: Array<[number, number]>): GeoJsonGeometry {
  return {
    type: 'Polygon',
    coordinates: [[...positions, positions[0]]],
  };
}
