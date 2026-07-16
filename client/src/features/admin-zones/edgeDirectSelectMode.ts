import MapboxDraw from '@mapbox/mapbox-gl-draw';
import type mapboxgl from 'mapbox-gl';

/**
 * mapbox-gl-draw's stock `direct_select` mode only lets you drag one vertex
 * (or a shift-click multi-selection of vertices) at a time. Zone editing is
 * usually about moving a whole edge or a cluster of nearby vertices, so this
 * wraps the built-in mode and adds two interactions on top of it:
 *
 *  - Edge drag: clicking a point that lies on a boundary segment (rather
 *    than on a vertex handle) selects both of that segment's endpoints and
 *    starts the same drag the built-in mode already uses for multi-vertex
 *    selections.
 *  - Box select: dragging from the zone interior draws a marquee around the
 *    vertices to select. A plain drag replaces the current selection, while
 *    Shift-drag adds to it. Shift-dragging from empty space also starts an
 *    additive box selection; plain drags from empty space still pan the map.
 *
 * This relies on `direct_select`'s internal helpers (startDragging,
 * pathsToCoordinates, onVertex, ...), which exist at runtime but aren't part
 * of the published TypeScript types — hence the casts below.
 */

const EDGE_DRAG_THRESHOLD_PX = 10;

type Position = [number, number];

interface DirectSelectFeature {
  type: string;
  coordinates: Position[][];
  getFeatures?: () => Array<{ coordinates: Position[][] }>;
}

interface BoxSelectSession {
  active: boolean;
  additive: boolean;
  startPoint: { x: number; y: number };
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  element: HTMLDivElement;
  initialDragPanEnabled: boolean;
}

interface DirectSelectState {
  featureId: string;
  feature: DirectSelectFeature;
  selectedCoordPaths: string[];
  boxSelect?: BoxSelectSession;
}

interface FeatureTargetLike {
  properties?: { meta?: string; active?: string } | null;
}

interface DrawMouseEvent {
  point: { x: number; y: number };
  lngLat: mapboxgl.LngLat;
  originalEvent: MouseEvent;
  featureTarget?: FeatureTargetLike;
}

interface DirectSelectModeThis {
  map: mapboxgl.Map;
  pathsToCoordinates(featureId: string, paths: string[]): Array<{ feature_id: string; coord_path: string }>;
  setSelectedCoordinates(coords: Array<{ feature_id: string; coord_path: string }>): void;
  startDragging(state: DirectSelectState, e: DrawMouseEvent): void;
  onVertex(state: DirectSelectState, e: DrawMouseEvent): void;
  onMidpoint(state: DirectSelectState, e: DrawMouseEvent): void;
  onFeature(state: DirectSelectState, e: DrawMouseEvent): void;
}

type BaseDirectSelectMode = Record<string, unknown> & {
  onFeature: (this: DirectSelectModeThis, state: DirectSelectState, e: DrawMouseEvent) => void;
  onDrag: (this: DirectSelectModeThis, state: DirectSelectState, e: DrawMouseEvent) => void;
  onMouseUp: (this: DirectSelectModeThis, state: DirectSelectState, e: DrawMouseEvent) => void;
  onStop: (this: DirectSelectModeThis, state: DirectSelectState) => void;
};

export function createEdgeAwareDirectSelectMode(): MapboxDraw.DrawCustomMode {
  const base = MapboxDraw.modes.direct_select as unknown as BaseDirectSelectMode;

  const onFeature = function onFeature(this: DirectSelectModeThis, state: DirectSelectState, e: DrawMouseEvent) {
    const edgePaths = findEdgeCoordPaths(this.map, state.feature, e.point);
    if (edgePaths) {
      state.selectedCoordPaths = edgePaths;
      this.setSelectedCoordinates(this.pathsToCoordinates(state.featureId, state.selectedCoordPaths));
      this.startDragging(state, e);
      return;
    }
    startBoxSelect(this, state, e);
  };

  const onPointerDown = function onPointerDown(this: DirectSelectModeThis, state: DirectSelectState, e: DrawMouseEvent) {
    if (isVertexTarget(e)) { this.onVertex(state, e); return; }
    if (isMidpointTarget(e)) { this.onMidpoint(state, e); return; }
    if (isActiveFeatureTarget(e)) { this.onFeature(state, e); return; }
    if (isShiftDown(e)) { startBoxSelect(this, state, e); }
  };

  const onDrag = function onDrag(this: DirectSelectModeThis, state: DirectSelectState, e: DrawMouseEvent) {
    if (state.boxSelect?.active) {
      updateBoxSelect(state, e);
      return;
    }
    base.onDrag.call(this, state, e);
  };

  const onPointerUp = function onPointerUp(this: DirectSelectModeThis, state: DirectSelectState, e: DrawMouseEvent) {
    if (state.boxSelect?.active) {
      finishBoxSelect(this, state);
      return;
    }
    base.onMouseUp.call(this, state, e);
  };

  const onStop = function onStop(this: DirectSelectModeThis, state: DirectSelectState) {
    cancelBoxSelect(this, state);
    base.onStop.call(this, state);
  };

  return {
    ...base,
    onFeature,
    onMouseDown: onPointerDown,
    onTouchStart: onPointerDown,
    onDrag,
    onMouseUp: onPointerUp,
    onTouchEnd: onPointerUp,
    onStop,
  } as unknown as MapboxDraw.DrawCustomMode;
}

// ── Edge drag ──────────────────────────────────────────────────────────────

function findEdgeCoordPaths(
  map: mapboxgl.Map,
  feature: DirectSelectFeature,
  point: { x: number; y: number },
): string[] | null {
  const best: { current: { distance: number; coordPaths: string[] } | null } = { current: null };

  forEachFeatureRing(feature, (ring, pathPrefix) => {
    for (let index = 0; index < ring.length; index += 1) {
      const nextIndex = (index + 1) % ring.length;
      const start = map.project(ring[index]);
      const end = map.project(ring[nextIndex]);
      const distance = pointToSegmentDistance(point, start, end);
      if (distance <= EDGE_DRAG_THRESHOLD_PX && (!best.current || distance < best.current.distance)) {
        best.current = { distance, coordPaths: [`${pathPrefix}${index}`, `${pathPrefix}${nextIndex}`] };
      }
    }
  });

  return best.current ? best.current.coordPaths : null;
}

function pointToSegmentDistance(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = (segmentX * segmentX) + (segmentY * segmentY);
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, (((point.x - start.x) * segmentX) + ((point.y - start.y) * segmentY)) / lengthSquared));
  const closestX = start.x + (t * segmentX);
  const closestY = start.y + (t * segmentY);
  return Math.hypot(point.x - closestX, point.y - closestY);
}

// ── Box select ─────────────────────────────────────────────────────────────

function startBoxSelect(mode: DirectSelectModeThis, state: DirectSelectState, e: DrawMouseEvent): void {
  const element = document.createElement('div');
  Object.assign(element.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '0',
    height: '0',
    border: '1.5px solid #2a6a8a',
    background: 'rgba(42,106,138,0.14)',
    pointerEvents: 'none',
    zIndex: '5',
  });
  mode.map.getContainer().appendChild(element);

  state.boxSelect = {
    active: true,
    additive: isShiftDown(e),
    startPoint: { x: e.point.x, y: e.point.y },
    bounds: { minX: e.point.x, minY: e.point.y, maxX: e.point.x, maxY: e.point.y },
    element,
    initialDragPanEnabled: mode.map.dragPan.isEnabled(),
  };
  mode.map.dragPan.disable();
}

function updateBoxSelect(state: DirectSelectState, e: DrawMouseEvent): void {
  const box = state.boxSelect;
  if (!box) return;

  const minX = Math.min(box.startPoint.x, e.point.x);
  const maxX = Math.max(box.startPoint.x, e.point.x);
  const minY = Math.min(box.startPoint.y, e.point.y);
  const maxY = Math.max(box.startPoint.y, e.point.y);
  box.bounds = { minX, minY, maxX, maxY };

  Object.assign(box.element.style, {
    left: `${minX}px`,
    top: `${minY}px`,
    width: `${maxX - minX}px`,
    height: `${maxY - minY}px`,
  });
}

function finishBoxSelect(mode: DirectSelectModeThis, state: DirectSelectState): void {
  const box = state.boxSelect;
  if (!box) return;

  const matched = collectVertexPathsInBox(mode.map, state.feature, box.bounds);
  teardownBoxSelect(mode, state);

  state.selectedCoordPaths = box.additive
    ? Array.from(new Set([...state.selectedCoordPaths, ...matched]))
    : matched;
  mode.setSelectedCoordinates(mode.pathsToCoordinates(state.featureId, state.selectedCoordPaths));
}

function cancelBoxSelect(mode: DirectSelectModeThis, state: DirectSelectState): void {
  if (state.boxSelect) teardownBoxSelect(mode, state);
}

function teardownBoxSelect(mode: DirectSelectModeThis, state: DirectSelectState): void {
  const box = state.boxSelect;
  if (!box) return;
  box.element.remove();
  if (box.initialDragPanEnabled) mode.map.dragPan.enable();
  state.boxSelect = undefined;
}

function collectVertexPathsInBox(
  map: mapboxgl.Map,
  feature: DirectSelectFeature,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): string[] {
  const matched: string[] = [];
  forEachFeatureRing(feature, (ring, pathPrefix) => {
    ring.forEach((position, index) => {
      const projected = map.project(position);
      if (
        projected.x >= bounds.minX && projected.x <= bounds.maxX
        && projected.y >= bounds.minY && projected.y <= bounds.maxY
      ) {
        matched.push(`${pathPrefix}${index}`);
      }
    });
  });
  return matched;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function forEachFeatureRing(feature: DirectSelectFeature, visit: (ring: Position[], pathPrefix: string) => void): void {
  if (feature.type === 'Polygon') {
    feature.coordinates.forEach((ring, ringIndex) => visit(ring, `${ringIndex}.`));
  } else if (feature.type === 'MultiPolygon' && feature.getFeatures) {
    feature.getFeatures().forEach((polygonFeature, polygonIndex) => {
      polygonFeature.coordinates.forEach((ring, ringIndex) => visit(ring, `${polygonIndex}.${ringIndex}.`));
    });
  }
}

function isVertexTarget(e: DrawMouseEvent): boolean {
  return e.featureTarget?.properties?.meta === 'vertex';
}

function isMidpointTarget(e: DrawMouseEvent): boolean {
  return e.featureTarget?.properties?.meta === 'midpoint';
}

function isActiveFeatureTarget(e: DrawMouseEvent): boolean {
  return e.featureTarget?.properties?.meta === 'feature' && e.featureTarget?.properties?.active === 'true';
}

function isShiftDown(e: DrawMouseEvent): boolean {
  return e.originalEvent?.shiftKey === true;
}
