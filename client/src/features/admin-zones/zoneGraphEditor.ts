import mapboxgl from 'mapbox-gl';
import {
  buildZoneGraph,
  cloneZoneGraph,
  deleteGraphNodes,
  extractZoneGeometries,
  insertGraphNodeOnEdge,
  listGraphEdges,
  listGraphNodeIds,
  moveGraphNodes,
  weldGraphNodeIntoEdge,
  weldGraphNodes,
} from '@city-game/shared';
import type { GeoJsonGeometry, ZoneGraph, ZoneGraphEdge } from '@city-game/shared';

type Position = [number, number];

export interface ZoneGraphEditorZone {
  id: string;
  name: string;
  geometry: GeoJsonGeometry;
}

export interface ZoneGraphEditorState {
  selectedCount: number;
  changedZoneIds: string[];
  canUndo: boolean;
  canRedo: boolean;
  hasSelfIntersections: boolean;
}

export interface ZoneGraphEditorCallbacks {
  /** Fired whenever geometry changes: the current geometry of every changed zone. */
  onPreview(geometries: Record<string, GeoJsonGeometry>, changedZoneIds: string[]): void;
  onState(state: ZoneGraphEditorState): void;
  onNotice(tone: 'info' | 'error', message: string): void;
}

const NODE_SOURCE = 'zone-graph-node-source';
const MIDPOINT_SOURCE = 'zone-graph-midpoint-source';
const TRACE_SOURCE = 'zone-graph-trace-source';
const INTERSECTION_SOURCE = 'zone-graph-intersection-source';
const NODE_HALO_LAYER = 'zone-graph-node-halo';
const NODE_LAYER = 'zone-graph-node';
const MIDPOINT_LAYER = 'zone-graph-midpoint';
const TRACE_LINE_LAYER = 'zone-graph-trace-line';
const INTERSECTION_HALO_LAYER = 'zone-graph-intersection-halo';
const INTERSECTION_DOT_LAYER = 'zone-graph-intersection-dot';
const HIT_RADIUS_PX = 7;
const SNAP_RADIUS_PX = 14;
const TRACE_COLOR = '#e0821e';
const INTERSECTION_COLOR = '#d81e1e';

interface DragSession {
  kind: 'nodes';
  startLngLat: Position;
  startPositions: Map<number, Position>;
  moved: boolean;
  mutated: boolean;
  snap: { type: 'node'; nodeId: number } | { type: 'edge'; edge: ZoneGraphEdge } | null;
}

interface MarqueeSession {
  kind: 'marquee';
  additive: boolean;
  start: { x: number; y: number };
  element: HTMLDivElement;
}

/**
 * Map-wide shared-boundary editor. Builds a shared-node graph from every
 * polygonal zone and lets the admin drag/insert/delete/weld nodes directly on
 * the map. Because adjoining zones reference the same nodes, edits can never
 * open a gap along a shared boundary — moving a T-junction reshapes all three
 * zones at once.
 *
 * Interactions:
 *  - drag node: move it (moves it in every zone that shares it)
 *  - click node: select · shift+click: add/remove from selection
 *  - shift+drag empty map: marquee-select nodes (ctrl adds to selection)
 *  - drag a selected node: move the whole selection together
 *  - click/drag a small hollow dot (edge midpoint): insert a node there
 *  - drag a node onto another node or edge: weld boundaries together
 *  - Delete: remove selected nodes · Ctrl+Z / Ctrl+Y: undo / redo · Esc: clear selection
 *
 * Selecting a node traces every ring that owns it as a dashed orange line —
 * the only way to tell which zone's boundary a shared dot belongs to, since
 * several zones' rings can pass through the exact same point. Any point
 * where a traced ring now crosses itself is marked with a red dot; a save
 * with self-intersections still present is refused client-side, since
 * PostGIS would reject it anyway (`ST_IsValid` requires simple rings).
 */
export class ZoneGraphEditor {
  private readonly map: mapboxgl.Map;
  private readonly callbacks: ZoneGraphEditorCallbacks;
  private readonly zoneNameById = new Map<string, string>();
  private readonly originalGeometryJson = new Map<string, string>();

  private graph: ZoneGraph;
  private selection = new Set<number>();
  private history: ZoneGraph[] = [];
  private historyIndex = 0;

  private drag: DragSession | MarqueeSession | null = null;
  private previewFrame: number | null = null;
  private destroyed = false;

  private readonly snapMarkerElement: HTMLDivElement;
  private readonly snapMarker: mapboxgl.Marker;
  private readonly boxZoomWasEnabled: boolean;

  readonly skippedZoneIds: string[];

  private cachedNodeIds: number[] | null = null;
  private cachedEdges: ZoneGraphEdge[] | null = null;
  private hasSelfIntersections = false;

  private readonly onMouseDown = (event: mapboxgl.MapMouseEvent) => this.handleMouseDown(event);
  private readonly onHoverMove = (event: mapboxgl.MapMouseEvent) => this.handleHoverMove(event);
  private readonly onWindowMouseMove = (event: MouseEvent) => this.handleWindowMouseMove(event);
  private readonly onWindowMouseUp = (event: MouseEvent) => this.handleWindowMouseUp(event);
  private readonly onKeyDown = (event: KeyboardEvent) => this.handleKeyDown(event);

  constructor(map: mapboxgl.Map, zones: ZoneGraphEditorZone[], callbacks: ZoneGraphEditorCallbacks) {
    this.map = map;
    this.callbacks = callbacks;

    const { graph, skippedZoneIds } = buildZoneGraph(zones);
    this.graph = graph;
    this.skippedZoneIds = skippedZoneIds;
    for (const zone of zones) {
      this.zoneNameById.set(zone.id, zone.name);
      this.originalGeometryJson.set(zone.id, JSON.stringify(zone.geometry));
    }

    this.history = [cloneZoneGraph(graph)];
    this.historyIndex = 0;

    this.boxZoomWasEnabled = map.boxZoom.isEnabled();
    map.boxZoom.disable();

    this.snapMarkerElement = document.createElement('div');
    Object.assign(this.snapMarkerElement.style, {
      width: '16px',
      height: '16px',
      background: 'rgba(200,180,138,0.6)',
      border: '2.5px solid #6b4220',
      borderRadius: '50%',
      pointerEvents: 'none',
      display: 'none',
      boxShadow: '0 0 0 5px rgba(200,180,138,0.28)',
    });
    this.snapMarker = new mapboxgl.Marker({ element: this.snapMarkerElement, anchor: 'center' });

    this.ensureLayers();
    this.refreshSources();
    this.schedulePreview();

    map.on('mousedown', this.onMouseDown);
    map.on('mousemove', this.onHoverMove);
    window.addEventListener('mousemove', this.onWindowMouseMove);
    window.addEventListener('mouseup', this.onWindowMouseUp);
    window.addEventListener('keydown', this.onKeyDown);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.previewFrame !== null) cancelAnimationFrame(this.previewFrame);
    this.cancelActiveDrag();
    this.map.off('mousedown', this.onMouseDown);
    this.map.off('mousemove', this.onHoverMove);
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
    window.removeEventListener('keydown', this.onKeyDown);
    this.snapMarker.remove();
    for (const layerId of [
      INTERSECTION_DOT_LAYER, INTERSECTION_HALO_LAYER,
      MIDPOINT_LAYER, NODE_LAYER, NODE_HALO_LAYER, TRACE_LINE_LAYER,
    ]) {
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    }
    for (const sourceId of [NODE_SOURCE, MIDPOINT_SOURCE, TRACE_SOURCE, INTERSECTION_SOURCE]) {
      if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
    }
    if (this.boxZoomWasEnabled) this.map.boxZoom.enable();
    this.map.getCanvas().style.cursor = '';
  }

  getChangedGeometries(): Array<{ zoneId: string; geometry: GeoJsonGeometry }> {
    const extracted = extractZoneGeometries(this.graph);
    const changed: Array<{ zoneId: string; geometry: GeoJsonGeometry }> = [];
    for (const [zoneId, geometry] of Object.entries(extracted)) {
      if (JSON.stringify(geometry) !== this.originalGeometryJson.get(zoneId)) {
        changed.push({ zoneId, geometry });
      }
    }
    return changed;
  }

  deleteSelection(): void {
    if (this.selection.size === 0) {
      this.callbacks.onNotice('info', 'Select one or more corner dots first (click, or shift+drag a box).');
      return;
    }
    const result = deleteGraphNodes(this.graph, this.selection);
    if (!result.ok) {
      const names = result.blockedZoneIds.map((zoneId) => `"${this.zoneNameById.get(zoneId) ?? zoneId}"`).join(', ');
      this.callbacks.onNotice('error', `Cannot delete: ${names} would drop below three corners.`);
      return;
    }
    this.selection.clear();
    this.invalidateTopology();
    this.pushHistory();
    this.refreshSources();
    this.schedulePreview();
  }

  undo(): void {
    if (this.historyIndex <= 0) {
      this.callbacks.onNotice('info', 'Nothing to undo.');
      return;
    }
    this.historyIndex -= 1;
    this.restoreFromHistory();
  }

  redo(): void {
    if (this.historyIndex >= this.history.length - 1) {
      this.callbacks.onNotice('info', 'Nothing to redo.');
      return;
    }
    this.historyIndex += 1;
    this.restoreFromHistory();
  }

  clearSelection(): void {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.refreshSources();
    this.emitState();
  }

  // ── Event handling ─────────────────────────────────────────────────────────

  private handleMouseDown(event: mapboxgl.MapMouseEvent): void {
    if (event.originalEvent.button !== 0) return;

    const nodeId = this.hitTestNode(event.point);
    if (nodeId !== null) {
      event.preventDefault();
      if (event.originalEvent.shiftKey) {
        if (this.selection.has(nodeId)) this.selection.delete(nodeId);
        else this.selection.add(nodeId);
        this.refreshSources();
        this.emitState();
        return;
      }
      if (!this.selection.has(nodeId)) {
        this.selection = new Set([nodeId]);
        this.refreshSources();
        this.emitState();
      }
      this.beginNodeDrag(event, false);
      return;
    }

    const midpoint = this.hitTestMidpoint(event.point);
    if (midpoint !== null) {
      event.preventDefault();
      const a = this.graph.positions[midpoint.a];
      const b = this.graph.positions[midpoint.b];
      const inserted = insertGraphNodeOnEdge(this.graph, midpoint.a, midpoint.b, [
        (a[0] + b[0]) / 2,
        (a[1] + b[1]) / 2,
      ]);
      if (inserted === null) return;
      this.invalidateTopology();
      this.selection = new Set([inserted]);
      this.refreshSources();
      this.emitState();
      this.beginNodeDrag(event, true);
      return;
    }

    if (event.originalEvent.shiftKey) {
      event.preventDefault();
      this.beginMarquee(event);
      return;
    }
  }

  private beginNodeDrag(event: mapboxgl.MapMouseEvent, mutated: boolean): void {
    const startPositions = new Map<number, Position>();
    for (const nodeId of this.selection) {
      const position = this.graph.positions[nodeId];
      if (position) startPositions.set(nodeId, [position[0], position[1]]);
    }
    this.drag = {
      kind: 'nodes',
      startLngLat: [event.lngLat.lng, event.lngLat.lat],
      startPositions,
      moved: false,
      mutated,
      snap: null,
    };
    this.map.getCanvas().style.cursor = 'grabbing';
  }

  private beginMarquee(event: mapboxgl.MapMouseEvent): void {
    const element = document.createElement('div');
    Object.assign(element.style, {
      position: 'absolute',
      border: '1.5px solid #2a6a8a',
      background: 'rgba(42,106,138,0.14)',
      pointerEvents: 'none',
      zIndex: '5',
      left: `${event.point.x}px`,
      top: `${event.point.y}px`,
      width: '0px',
      height: '0px',
    });
    this.map.getContainer().appendChild(element);
    this.drag = {
      kind: 'marquee',
      additive: event.originalEvent.ctrlKey || event.originalEvent.metaKey,
      start: { x: event.point.x, y: event.point.y },
      element,
    };
  }

  private handleHoverMove(event: mapboxgl.MapMouseEvent): void {
    if (this.drag) return;
    const overNode = this.hitTestNode(event.point) !== null;
    const overMidpoint = !overNode && this.hitTestMidpoint(event.point) !== null;
    this.map.getCanvas().style.cursor = overNode ? 'move' : overMidpoint ? 'copy' : '';
  }

  private pointFromClient(event: MouseEvent): { x: number; y: number } {
    const rect = this.map.getContainer().getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private handleWindowMouseMove(event: MouseEvent): void {
    if (!this.drag) return;
    const point = this.pointFromClient(event);

    if (this.drag.kind === 'marquee') {
      const minX = Math.min(this.drag.start.x, point.x);
      const minY = Math.min(this.drag.start.y, point.y);
      Object.assign(this.drag.element.style, {
        left: `${minX}px`,
        top: `${minY}px`,
        width: `${Math.abs(point.x - this.drag.start.x)}px`,
        height: `${Math.abs(point.y - this.drag.start.y)}px`,
      });
      return;
    }

    const lngLat = this.map.unproject([point.x, point.y]);
    const deltaLng = lngLat.lng - this.drag.startLngLat[0];
    const deltaLat = lngLat.lat - this.drag.startLngLat[1];
    this.drag.moved = this.drag.moved || Math.abs(deltaLng) + Math.abs(deltaLat) > 0;

    const updates = new Map<number, Position>();
    for (const [nodeId, start] of this.drag.startPositions) {
      updates.set(nodeId, [start[0] + deltaLng, start[1] + deltaLat]);
    }

    // Single-node drags can snap onto (and weld with) other nodes and edges.
    this.drag.snap = null;
    this.snapMarkerElement.style.display = 'none';
    if (this.drag.startPositions.size === 1) {
      const [draggedId] = this.drag.startPositions.keys();
      const draggedTo = updates.get(draggedId)!;
      const snap = this.findSnapTarget(draggedId, draggedTo);
      if (snap) {
        this.drag.snap = snap.target;
        updates.set(draggedId, snap.position);
        this.snapMarkerElement.style.display = 'block';
        this.snapMarker.setLngLat(snap.position).addTo(this.map);
      }
    }

    moveGraphNodes(this.graph, updates);
    this.refreshSources();
    this.schedulePreview();
  }

  private handleWindowMouseUp(event: MouseEvent): void {
    if (!this.drag) return;
    const point = this.pointFromClient(event);

    if (this.drag.kind === 'marquee') {
      const bounds = {
        minX: Math.min(this.drag.start.x, point.x),
        maxX: Math.max(this.drag.start.x, point.x),
        minY: Math.min(this.drag.start.y, point.y),
        maxY: Math.max(this.drag.start.y, point.y),
      };
      const matched = new Set<number>();
      for (const nodeId of this.nodeIds()) {
        const position = this.graph.positions[nodeId];
        const projected = this.map.project([position[0], position[1]]);
        if (projected.x >= bounds.minX && projected.x <= bounds.maxX
          && projected.y >= bounds.minY && projected.y <= bounds.maxY) {
          matched.add(nodeId);
        }
      }
      this.selection = this.drag.additive
        ? new Set([...this.selection, ...matched])
        : matched;
      this.drag.element.remove();
      this.drag = null;
      this.refreshSources();
      this.emitState();
      return;
    }

    const { moved, mutated, snap, startPositions } = this.drag;
    this.drag = null;
    this.snapMarkerElement.style.display = 'none';
    this.map.getCanvas().style.cursor = '';

    if (snap && startPositions.size === 1) {
      const [draggedId] = startPositions.keys();
      const result = snap.type === 'node'
        ? weldGraphNodes(this.graph, draggedId, snap.nodeId)
        : weldGraphNodeIntoEdge(this.graph, draggedId, snap.edge.a, snap.edge.b);
      if (result.ok) {
        this.invalidateTopology();
        this.selection = snap.type === 'node' ? new Set([snap.nodeId]) : new Set([draggedId]);
        this.callbacks.onNotice('info', snap.type === 'node'
          ? 'Corners welded — they now move together.'
          : 'Corner welded into the boundary — the edge is now shared.');
      } else {
        this.callbacks.onNotice('error', result.reason ?? 'Could not weld those boundaries.');
      }
    }

    if (moved || mutated) {
      this.pushHistory();
      this.refreshSources();
      this.schedulePreview();
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const target = event.target;
    if (target instanceof HTMLElement
      && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.undo();
      return;
    }
    if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y')
      || ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'z')) {
      event.preventDefault();
      this.redo();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.deleteSelection();
      return;
    }
    if (event.key === 'Escape') {
      this.clearSelection();
    }
  }

  // ── Snapping & hit-testing ────────────────────────────────────────────────

  /** Node/edge lists are cached between structural changes — hit-testing runs on every mousemove. */
  private nodeIds(): number[] {
    if (!this.cachedNodeIds) this.cachedNodeIds = listGraphNodeIds(this.graph);
    return this.cachedNodeIds;
  }

  private edges(): ZoneGraphEdge[] {
    if (!this.cachedEdges) this.cachedEdges = listGraphEdges(this.graph);
    return this.cachedEdges;
  }

  private invalidateTopology(): void {
    this.cachedNodeIds = null;
    this.cachedEdges = null;
  }

  private hitTestNode(point: { x: number; y: number }): number | null {
    let best: number | null = null;
    let bestDistance = HIT_RADIUS_PX;
    for (const nodeId of this.nodeIds()) {
      const position = this.graph.positions[nodeId];
      const projected = this.map.project([position[0], position[1]]);
      const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = nodeId;
      }
    }
    return best;
  }

  private hitTestMidpoint(point: { x: number; y: number }): ZoneGraphEdge | null {
    let best: ZoneGraphEdge | null = null;
    let bestDistance = HIT_RADIUS_PX;
    for (const edge of this.edges()) {
      const a = this.graph.positions[edge.a];
      const b = this.graph.positions[edge.b];
      const projected = this.map.project([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = edge;
      }
    }
    return best;
  }

  private findSnapTarget(
    draggedId: number,
    draggedTo: Position,
  ): { target: NonNullable<DragSession['snap']>; position: Position } | null {
    const draggedPoint = this.map.project([draggedTo[0], draggedTo[1]]);

    let bestNode: number | null = null;
    let bestNodeDistance = SNAP_RADIUS_PX;
    for (const nodeId of this.nodeIds()) {
      if (nodeId === draggedId || this.selection.has(nodeId)) continue;
      const position = this.graph.positions[nodeId];
      const projected = this.map.project([position[0], position[1]]);
      const distance = Math.hypot(projected.x - draggedPoint.x, projected.y - draggedPoint.y);
      if (distance <= bestNodeDistance) {
        bestNodeDistance = distance;
        bestNode = nodeId;
      }
    }
    if (bestNode !== null) {
      const position = this.graph.positions[bestNode];
      return { target: { type: 'node', nodeId: bestNode }, position: [position[0], position[1]] };
    }

    let bestEdge: ZoneGraphEdge | null = null;
    let bestEdgePosition: Position | null = null;
    let bestEdgeDistance = SNAP_RADIUS_PX;
    for (const edge of this.edges()) {
      if (edge.a === draggedId || edge.b === draggedId) continue;
      if (this.selection.has(edge.a) || this.selection.has(edge.b)) continue;
      const a = this.map.project(this.graph.positions[edge.a] as [number, number]);
      const b = this.map.project(this.graph.positions[edge.b] as [number, number]);
      const segmentX = b.x - a.x;
      const segmentY = b.y - a.y;
      const lengthSquared = (segmentX * segmentX) + (segmentY * segmentY);
      const t = lengthSquared === 0
        ? 0
        : Math.max(0.02, Math.min(0.98, (((draggedPoint.x - a.x) * segmentX) + ((draggedPoint.y - a.y) * segmentY)) / lengthSquared));
      const closestX = a.x + (t * segmentX);
      const closestY = a.y + (t * segmentY);
      const distance = Math.hypot(draggedPoint.x - closestX, draggedPoint.y - closestY);
      if (distance <= bestEdgeDistance) {
        bestEdgeDistance = distance;
        bestEdge = edge;
        const start = this.graph.positions[edge.a];
        const end = this.graph.positions[edge.b];
        bestEdgePosition = [start[0] + ((end[0] - start[0]) * t), start[1] + ((end[1] - start[1]) * t)];
      }
    }
    if (bestEdge && bestEdgePosition) {
      return { target: { type: 'edge', edge: bestEdge }, position: bestEdgePosition };
    }
    return null;
  }

  // ── Rendering & state ─────────────────────────────────────────────────────

  private ensureLayers(): void {
    if (!this.map.getSource(NODE_SOURCE)) {
      this.map.addSource(NODE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!this.map.getSource(MIDPOINT_SOURCE)) {
      this.map.addSource(MIDPOINT_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!this.map.getSource(TRACE_SOURCE)) {
      this.map.addSource(TRACE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!this.map.getSource(INTERSECTION_SOURCE)) {
      this.map.addSource(INTERSECTION_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!this.map.getLayer(TRACE_LINE_LAYER)) {
      this.map.addLayer({
        id: TRACE_LINE_LAYER,
        type: 'line',
        source: TRACE_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': TRACE_COLOR,
          'line-width': 3,
          'line-dasharray': [1.6, 1.3],
        },
      });
    }
    if (!this.map.getLayer(MIDPOINT_LAYER)) {
      this.map.addLayer({
        id: MIDPOINT_LAYER,
        type: 'circle',
        source: MIDPOINT_SOURCE,
        paint: {
          'circle-radius': 3.5,
          'circle-color': '#f7f5ef',
          'circle-stroke-color': '#8e6b2d',
          'circle-stroke-width': 1.5,
          'circle-opacity': 0.85,
        },
      });
    }
    if (!this.map.getLayer(NODE_HALO_LAYER)) {
      this.map.addLayer({
        id: NODE_HALO_LAYER,
        type: 'circle',
        source: NODE_SOURCE,
        paint: {
          'circle-radius': ['case', ['==', ['get', 'selected'], 1], 10, 7.5],
          'circle-color': '#f7f5ef',
          'circle-opacity': 0.9,
        },
      });
    }
    if (!this.map.getLayer(NODE_LAYER)) {
      this.map.addLayer({
        id: NODE_LAYER,
        type: 'circle',
        source: NODE_SOURCE,
        paint: {
          'circle-radius': ['case', ['==', ['get', 'selected'], 1], 6.5, 4.5],
          'circle-color': ['case', ['==', ['get', 'selected'], 1], '#b3541e', '#8e6b2d'],
          'circle-stroke-color': '#f7f5ef',
          'circle-stroke-width': 1,
        },
      });
    }
    if (!this.map.getLayer(INTERSECTION_HALO_LAYER)) {
      this.map.addLayer({
        id: INTERSECTION_HALO_LAYER,
        type: 'circle',
        source: INTERSECTION_SOURCE,
        paint: { 'circle-radius': 13, 'circle-color': INTERSECTION_COLOR, 'circle-opacity': 0.28 },
      });
    }
    if (!this.map.getLayer(INTERSECTION_DOT_LAYER)) {
      this.map.addLayer({
        id: INTERSECTION_DOT_LAYER,
        type: 'circle',
        source: INTERSECTION_SOURCE,
        paint: {
          'circle-radius': 5.5,
          'circle-color': INTERSECTION_COLOR,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
        },
      });
    }
  }

  private refreshSources(): void {
    const nodeFeatures = this.nodeIds().map((nodeId) => ({
      type: 'Feature' as const,
      id: nodeId,
      geometry: { type: 'Point' as const, coordinates: this.graph.positions[nodeId] },
      properties: { nodeId, selected: this.selection.has(nodeId) ? 1 : 0 },
    }));
    (this.map.getSource(NODE_SOURCE) as mapboxgl.GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features: nodeFeatures });

    const midpointFeatures = this.edges().map((edge, index) => {
      const a = this.graph.positions[edge.a];
      const b = this.graph.positions[edge.b];
      return {
        type: 'Feature' as const,
        id: index,
        geometry: { type: 'Point' as const, coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] },
        properties: { a: edge.a, b: edge.b },
      };
    });
    (this.map.getSource(MIDPOINT_SOURCE) as mapboxgl.GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features: midpointFeatures });

    this.refreshTrace();
  }

  /**
   * Traces the ring(s) that own the currently selected node(s) as a dashed
   * line, and flags any point where the ring now crosses itself. Solves two
   * problems at once: at a shared node several zones' boundaries overlap at
   * the same dot, so there's no way to see "whose edge is this" just by
   * looking at it — the trace shows the specific ring you're touching. And a
   * self-intersection (the #1 cause of a rejected save) becomes visible
   * immediately instead of only at save time.
   *
   * Only checks edges touching a selected node against the rest of the same
   * ring (adjacent edges skipped, since they legitimately share an endpoint).
   * That keeps this cheap enough to run on every mousemove even for a
   * 1000+ vertex ring — only the moved edges can have newly started crossing
   * anything, so there's no need to check the whole ring pairwise.
   */
  private refreshTrace(): void {
    const traced = this.computeTracedRings();

    const lineFeatures = traced.map((entry, index) => ({
      type: 'Feature' as const,
      id: index,
      geometry: { type: 'LineString' as const, coordinates: closeRing(entry.ring.map((nodeId) => this.graph.positions[nodeId])) },
      properties: { zoneId: entry.zoneId },
    }));
    (this.map.getSource(TRACE_SOURCE) as mapboxgl.GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features: lineFeatures });

    const intersections = dedupePositions(traced.flatMap((entry) => this.findRingSelfIntersections(entry.ring)));
    const intersectionFeatures = intersections.map((point, index) => ({
      type: 'Feature' as const,
      id: index,
      geometry: { type: 'Point' as const, coordinates: point },
      properties: {},
    }));
    (this.map.getSource(INTERSECTION_SOURCE) as mapboxgl.GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features: intersectionFeatures });

    this.hasSelfIntersections = intersections.length > 0;
  }

  /** Every ring, across every zone, that contains at least one selected node. */
  private computeTracedRings(): Array<{ zoneId: string; ring: number[] }> {
    if (this.selection.size === 0) return [];
    const traced: Array<{ zoneId: string; ring: number[] }> = [];
    for (const zone of this.graph.zones) {
      for (const polygon of zone.polygons) {
        for (const ring of polygon) {
          if (ring.some((nodeId) => this.selection.has(nodeId))) {
            traced.push({ zoneId: zone.zoneId, ring });
          }
        }
      }
    }
    return traced;
  }

  /** Proper crossings between edges touching a selected node and the rest of the same ring. */
  private findRingSelfIntersections(ring: number[]): Position[] {
    const n = ring.length;
    if (n < 4) return [];

    const changedEdgeIndices: number[] = [];
    for (let i = 0; i < n; i += 1) {
      if (this.selection.has(ring[i]) || this.selection.has(ring[(i + 1) % n])) changedEdgeIndices.push(i);
    }

    const points: Position[] = [];
    for (const i of changedEdgeIndices) {
      const a1 = this.graph.positions[ring[i]];
      const a2 = this.graph.positions[ring[(i + 1) % n]];
      for (let j = 0; j < n; j += 1) {
        if (j === i) continue;
        if (j === (i + 1) % n || (j + 1) % n === i) continue; // shares an endpoint — not a crossing
        const b1 = this.graph.positions[ring[j]];
        const b2 = this.graph.positions[ring[(j + 1) % n]];
        const point = properSegmentIntersection(a1, a2, b1, b2);
        if (point) points.push(point);
      }
    }
    return points;
  }

  private schedulePreview(): void {
    if (this.previewFrame !== null) return;
    this.previewFrame = requestAnimationFrame(() => {
      this.previewFrame = null;
      if (this.destroyed) return;
      this.emitPreview();
    });
  }

  private emitPreview(): void {
    const extracted = extractZoneGeometries(this.graph);
    const changed: Record<string, GeoJsonGeometry> = {};
    const changedZoneIds: string[] = [];
    for (const [zoneId, geometry] of Object.entries(extracted)) {
      if (JSON.stringify(geometry) !== this.originalGeometryJson.get(zoneId)) {
        changed[zoneId] = geometry;
        changedZoneIds.push(zoneId);
      }
    }
    this.callbacks.onPreview(changed, changedZoneIds);
    this.emitState(changedZoneIds);
  }

  private emitState(changedZoneIds?: string[]): void {
    this.callbacks.onState({
      selectedCount: this.selection.size,
      changedZoneIds: changedZoneIds ?? this.getChangedGeometries().map((entry) => entry.zoneId),
      canUndo: this.historyIndex > 0,
      canRedo: this.historyIndex < this.history.length - 1,
      hasSelfIntersections: this.hasSelfIntersections,
    });
  }

  private pushHistory(): void {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(cloneZoneGraph(this.graph));
    if (this.history.length > 100) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  private restoreFromHistory(): void {
    this.graph = cloneZoneGraph(this.history[this.historyIndex]);
    this.invalidateTopology();
    const validIds = new Set(this.nodeIds());
    this.selection = new Set([...this.selection].filter((nodeId) => validIds.has(nodeId)));
    this.refreshSources();
    this.schedulePreview();
  }

  private cancelActiveDrag(): void {
    if (this.drag?.kind === 'marquee') this.drag.element.remove();
    this.drag = null;
  }
}

function closeRing(positions: Position[]): Position[] {
  return positions.length > 0 ? [...positions, positions[0]] : positions;
}

/** Strict interior crossing of two segments — endpoints and shared-vertex touches don't count. */
function properSegmentIntersection(a1: Position, a2: Position, b1: Position, b2: Position): Position | null {
  const d1x = a2[0] - a1[0];
  const d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0];
  const d2y = b2[1] - b1[1];
  const denominator = (d1x * d2y) - (d1y * d2x);
  if (Math.abs(denominator) < 1e-15) return null; // parallel (or degenerate)

  const dx = b1[0] - a1[0];
  const dy = b1[1] - a1[1];
  const t = ((dx * d2y) - (dy * d2x)) / denominator;
  const u = ((dx * d1y) - (dy * d1x)) / denominator;
  const EPSILON = 1e-9;
  if (t <= EPSILON || t >= 1 - EPSILON || u <= EPSILON || u >= 1 - EPSILON) return null;

  return [a1[0] + (t * d1x), a1[1] + (t * d1y)];
}

function dedupePositions(positions: Position[]): Position[] {
  const seen = new Map<string, Position>();
  for (const position of positions) {
    const key = `${position[0].toFixed(9)},${position[1].toFixed(9)}`;
    if (!seen.has(key)) seen.set(key, position);
  }
  return Array.from(seen.values());
}
