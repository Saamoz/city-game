import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, ReactNode } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import type { Feature, FeatureCollection, GeoJsonProperties, MultiPolygon, Polygon } from 'geojson';
import { featureCollection, feature as turfFeature, intersect as turfIntersect } from '@turf/turf';
import { findAdjacencyGaps } from '@city-game/shared';
import type {
  AdjacencyGap,
  GeoJsonFeatureCollection,
  GeoJsonGeometry,
  JsonObject,
  MapDefinition,
  MapZone,
  Zone as RuntimeZone,
} from '@city-game/shared';
import {
  ApiError,
  createMapDefinition,
  createMapZoneCarving,
  deleteMapDefinition,
  deleteMapZoneDefinition,
  getMap,
  getMapZonePartitionStatus,
  healMapZoneGaps,
  importMapZoneDefinitions,
  listMaps,
  listMapZones,
  mergeMapZones,
  previewOsmMapZones,
  resolveMapZoneOverlap,
  splitMapZone,
  updateMapDefinition,
  updateMapZoneDefinition,
  updateMapZoneGeometries,
  type HealMapZoneGapsSkip,
  type MapUpsertInput,
  type MapZonePartitionReport,
  type MapZoneUpsertInput,
} from '../../lib/api';
import { buildRenderedZoneGeometry, collectGeometryPositions, getZoneAnchor } from '../game/mapGeometry';
import { ZoneGraphEditor } from './zoneGraphEditor';

interface AdminZoneEditorProps {
  initialMapId: string | null;
}

type EditorMode = 'select' | 'draw' | 'split' | 'boundaries';
type NoticeTone = 'info' | 'success' | 'error';
type ViewPresetId = 'toronto' | 'chicago' | 'custom';

interface NoticeState {
  tone: NoticeTone;
  message: string;
}

interface MapFormState {
  name: string;
  viewPresetId: ViewPresetId;
}

interface ZoneFormState {
  name: string;
}

interface ViewPreset {
  id: Exclude<ViewPresetId, 'custom'>;
  label: string;
  centerLat: number;
  centerLng: number;
  defaultZoom: number;
}

const mapboxToken = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? import.meta.env.MAPBOX_ACCESS_TOKEN ?? '').trim();
const MAP_STYLE = 'mapbox://styles/saamoz/cmng3j80c004001s831aw5e3b';
// ?blankBasemap=1 renders zones on a plain background without contacting the
// Mapbox APIs — useful offline and in sandboxed test browsers.
const useBlankBasemap = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('blankBasemap');
const BLANK_STYLE: mapboxgl.StyleSpecification = {
  version: 8,
  glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dfe5e2' } }],
};
const MAP_SOURCE_ID = 'admin-maps-source';
const MAP_FILL_LAYER_ID = 'admin-maps-fill';
const MAP_LINE_LAYER_ID = 'admin-maps-line';
const MAP_SELECTED_LAYER_ID = 'admin-maps-selected';
const MAP_LABEL_LAYER_ID = 'admin-maps-label';
const PREVIEW_SOURCE_ID = 'admin-maps-preview-source';
const PREVIEW_FILL_LAYER_ID = 'admin-maps-preview-fill';
const PREVIEW_LINE_LAYER_ID = 'admin-maps-preview-line';
const PREVIEW_LABEL_LAYER_ID = 'admin-maps-preview-label';
const GAP_SOURCE_ID = 'admin-maps-gap-source';
const GAP_HALO_LAYER_ID = 'admin-maps-gap-halo';
const GAP_DOT_LAYER_ID = 'admin-maps-gap-dot';
const OVERLAP_SOURCE_ID = 'admin-maps-overlap-source';
const OVERLAP_FILL_LAYER_ID = 'admin-maps-overlap-fill';
const OVERLAP_LINE_LAYER_ID = 'admin-maps-overlap-line';
const NEUTRAL_FILL = '#c8cdc5';
const NEUTRAL_LINE = '#667076';
const MERGE_TARGET_FILL = '#7ab0c8';
const MERGE_TARGET_LINE = '#2a6a8a';
const GAP_COLOR = '#c0392b';
const OVERLAP_COLOR = '#a83232';
const SNAP_THRESHOLD_PX = 18;
const DEFAULT_GAP_TOLERANCE_METERS = 2;

const VIEW_PRESETS: ViewPreset[] = [
  { id: 'toronto', label: 'Toronto', centerLat: 43.6532, centerLng: -79.3832, defaultZoom: 11 },
  { id: 'chicago', label: 'Chicago', centerLat: 41.8781, centerLng: -87.6298, defaultZoom: 11 },
];

const INITIAL_MAP_FORM: MapFormState = { name: '', viewPresetId: 'toronto' };
const INITIAL_ZONE_FORM: ZoneFormState = { name: '' };

export function AdminZoneEditor({ initialMapId }: AdminZoneEditorProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const snapMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const didFitBoundsRef = useRef(false);
  const zonesRef = useRef<MapZone[]>([]);
  const gapsRef = useRef<AdjacencyGap[]>([]);
  const overlapRegionsRef = useRef<GeoJsonGeometry[]>([]);
  const selectedZoneIdRef = useRef<string | null>(null);
  const previewCollectionRef = useRef<GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> | null>(null);
  const modeRef = useRef<EditorMode>('select');
  const splitZoneIdRef = useRef<string | null>(null);
  const suppressZoneSelectionUntilRef = useRef(0);
  const mergeTargetIdRef = useRef<string | null>(null);
  const mergePickModeRef = useRef(false);
  const draftActiveRef = useRef(false);
  const graphEditorRef = useRef<ZoneGraphEditor | null>(null);

  const [maps, setMaps] = useState<MapDefinition[]>([]);
  const [currentMap, setCurrentMap] = useState<MapDefinition | null>(null);
  const [mapForm, setMapForm] = useState<MapFormState>(INITIAL_MAP_FORM);
  const [mode, setMode] = useState<EditorMode>('select');
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [zones, setZones] = useState<MapZone[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [zoneForm, setZoneForm] = useState<ZoneFormState>(INITIAL_ZONE_FORM);
  const [geometryDraft, setGeometryDraft] = useState<GeoJsonGeometry | null>(null);
  const [boundaryPreview, setBoundaryPreview] = useState<Record<string, GeoJsonGeometry>>({});
  const [boundaryChangedZoneIds, setBoundaryChangedZoneIds] = useState<string[]>([]);
  const [boundarySelectedCount, setBoundarySelectedCount] = useState(0);
  const [boundaryCanUndo, setBoundaryCanUndo] = useState(false);
  const [boundaryCanRedo, setBoundaryCanRedo] = useState(false);
  const [boundaryHasSelfIntersections, setBoundaryHasSelfIntersections] = useState(false);
  const [isSavingBoundaries, setIsSavingBoundaries] = useState(false);
  const [isSavingMap, setIsSavingMap] = useState(false);
  const [isDeleteMapArmed, setIsDeleteMapArmed] = useState(false);
  const [isSavingZone, setIsSavingZone] = useState(false);
  const [isDeleteArmed, setIsDeleteArmed] = useState(false);
  const [previewCollection, setPreviewCollection] = useState<GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> | null>(null);
  const [previewOrigin, setPreviewOrigin] = useState<'osm' | 'file' | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isSplitting, setIsSplitting] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);
  const [isMergePickMode, setIsMergePickMode] = useState(false);
  const [gapToleranceMeters, setGapToleranceMeters] = useState(DEFAULT_GAP_TOLERANCE_METERS);
  const [isHealingGaps, setIsHealingGaps] = useState(false);
  const [showGapDetails, setShowGapDetails] = useState(false);
  const [partitionReport, setPartitionReport] = useState<MapZonePartitionReport | null>(null);
  const [isCheckingPartition, setIsCheckingPartition] = useState(false);
  const [lastHealSkips, setLastHealSkips] = useState<HealMapZoneGapsSkip[]>([]);
  const [showSkipDetails, setShowSkipDetails] = useState(false);
  const [resolvingOverlapKey, setResolvingOverlapKey] = useState<string | null>(null);

  const selectedZone = useMemo(() => zones.find((z) => z.id === selectedZoneId) ?? null, [selectedZoneId, zones]);
  const mergeTargetZone = useMemo(() => zones.find((z) => z.id === mergeTargetId) ?? null, [mergeTargetId, zones]);
  const renderedZones = useMemo(
    () => zones.map((zone) => ({
      ...zone,
      geometry: boundaryPreview[zone.id] ?? zone.geometry,
    })),
    [boundaryPreview, zones],
  );
  const hasGeometrySession = Boolean(geometryDraft) || mode === 'boundaries';
  const gapReport = useMemo(
    () => findAdjacencyGaps(zones, gapToleranceMeters),
    [zones, gapToleranceMeters],
  );
  const overlapRegions = useMemo(() => {
    if (!partitionReport || partitionReport.overlaps.length === 0) return [];
    const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
    const regions: GeoJsonGeometry[] = [];
    for (const overlap of partitionReport.overlaps) {
      const zoneA = zoneById.get(overlap.zoneAId);
      const zoneB = zoneById.get(overlap.zoneBId);
      if (!zoneA || !zoneB) continue;
      try {
        const intersection = turfIntersect(featureCollection([
          turfFeature(zoneA.geometry as Polygon | MultiPolygon),
          turfFeature(zoneB.geometry as Polygon | MultiPolygon),
        ]));
        if (intersection) regions.push(intersection.geometry as GeoJsonGeometry);
      } catch {
        // Skip pairs turf can't intersect cleanly -- the sidebar list still shows them.
      }
    }
    return regions;
  }, [zones, partitionReport]);

  // Sync refs
  useEffect(() => { zonesRef.current = zones; }, [zones]);
  useEffect(() => { gapsRef.current = gapReport.gaps; }, [gapReport]);
  useEffect(() => { overlapRegionsRef.current = overlapRegions; }, [overlapRegions]);
  useEffect(() => { selectedZoneIdRef.current = selectedZoneId; }, [selectedZoneId]);
  useEffect(() => { previewCollectionRef.current = previewCollection; }, [previewCollection]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { mergeTargetIdRef.current = mergeTargetId; }, [mergeTargetId]);
  useEffect(() => { mergePickModeRef.current = isMergePickMode; }, [isMergePickMode]);
  useEffect(() => { draftActiveRef.current = Boolean(geometryDraft); }, [geometryDraft]);
  // Tear down a live boundary-editing session if the component unmounts.
  useEffect(() => () => { graphEditorRef.current?.destroy(); graphEditorRef.current = null; }, []);

  useEffect(() => {
    if (!currentMap) return;
    setMapForm(buildFormFromMap(currentMap));
    setIsDeleteMapArmed(false);
    if (typeof window !== 'undefined') {
      window.history.replaceState({}, '', '/admin/zones?mapId=' + encodeURIComponent(currentMap.id));
    }
  }, [currentMap]);

  useEffect(() => {
    if (!selectedZone || hasGeometrySession) return;
    setZoneForm(buildFormFromZone(selectedZone));
    setIsDeleteArmed(false);
  }, [hasGeometrySession, selectedZone]);

  const clearGeometrySession = useCallback(() => {
    draftActiveRef.current = false;
    drawRef.current?.deleteAll();
    graphEditorRef.current?.destroy();
    graphEditorRef.current = null;
    setGeometryDraft(null);
    setBoundaryPreview({});
    setBoundaryChangedZoneIds([]);
    setBoundarySelectedCount(0);
    setBoundaryCanUndo(false);
    setBoundaryCanRedo(false);
    setBoundaryHasSelfIntersections(false);
    setMode('select');
    splitZoneIdRef.current = null;
    suppressZoneSelectionUntilRef.current = 0;
  }, []);

  const syncMapSources = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    syncEditorSources(
      map,
      renderedZones,
      selectedZoneId,
      mergeTargetId,
      previewCollection,
      new Set(boundaryChangedZoneIds),
      gapReport.gaps,
      overlapRegions,
    );
  }, [boundaryChangedZoneIds, gapReport, mergeTargetId, overlapRegions, previewCollection, renderedZones, selectedZoneId]);

  const fitMapToCurrentData = useCallback((focusZone?: MapZone | null) => {
    const map = mapRef.current;
    if (!map) return;

    if (focusZone) {
      fitMapToPositions(map, collectGeometryPositions(buildRenderedZoneGeometry(focusZone as unknown as RuntimeZone)), 96, 16.8);
      return;
    }
    const positions = zones.flatMap((z) => collectGeometryPositions(buildRenderedZoneGeometry(z as unknown as RuntimeZone)));
    if (positions.length > 0) {
      fitMapToPositions(map, positions, 92, 13.8);
      return;
    }
    const preset = getViewPreset(mapForm.viewPresetId);
    if (currentMap) {
      map.flyTo({ center: [currentMap.centerLng, currentMap.centerLat], zoom: currentMap.defaultZoom, essential: true });
      return;
    }
    if (preset) {
      map.flyTo({ center: [preset.centerLng, preset.centerLat], zoom: preset.defaultZoom, essential: true });
    }
  }, [currentMap, mapForm.viewPresetId, zones]);

  const focusZone = useCallback((zone: MapZone | null) => {
    if (!zone) return;
    setSelectedZoneId(zone.id);
    setZoneForm(buildFormFromZone(zone));
    fitMapToCurrentData(zone);
  }, [fitMapToCurrentData]);

  const refreshZones = useCallback(async (mapId: string) => {
    const nextZones = await listMapZones(mapId);
    setZones(nextZones);
    setSelectedZoneId((cur) => nextZones.some((z) => z.id === cur) ? cur : (nextZones[0]?.id ?? null));
    setMergeTargetId(null);
    setIsMergePickMode(false);
    return nextZones;
  }, []);

  const refreshPartitionStatus = useCallback(async (mapId: string) => {
    setIsCheckingPartition(true);
    try {
      const report = await getMapZonePartitionStatus(mapId);
      setPartitionReport(report);
    } catch {
      setPartitionReport(null);
    } finally {
      setIsCheckingPartition(false);
    }
  }, []);

  const loadMapBundle = useCallback(async (targetMapId?: string | null) => {
    setStatus('loading');
    setErrorMessage(null);
    setNotice(null);
    setPreviewCollection(null);
    setPreviewOrigin(null);
    setIsDeleteArmed(false);
    setMergeTargetId(null);
    setIsMergePickMode(false);
    setPartitionReport(null);
    setLastHealSkips([]);
    clearGeometrySession();

    try {
      const availableMaps = await listMaps();
      const resolvedMapId = targetMapId?.trim() || availableMaps[0]?.id || null;

      if (!resolvedMapId) {
        didFitBoundsRef.current = false;
        setMaps(availableMaps);
        setCurrentMap(null);
        setZones([]);
        setSelectedZoneId(null);
        setZoneForm(INITIAL_ZONE_FORM);
        setMapForm(INITIAL_MAP_FORM);
        setStatus('ready');
        if (typeof window !== 'undefined') window.history.replaceState({}, '', '/admin/zones');
        return;
      }

      const [nextMap, nextZones] = await Promise.all([getMap(resolvedMapId), listMapZones(resolvedMapId)]);
      didFitBoundsRef.current = false;
      setMaps(availableMaps);
      setCurrentMap(nextMap);
      setZones(nextZones);
      setSelectedZoneId(nextZones[0]?.id ?? null);
      setZoneForm(nextZones[0] ? buildFormFromZone(nextZones[0]) : INITIAL_ZONE_FORM);
      setStatus('ready');
      if (nextZones.length > 0) void refreshPartitionStatus(resolvedMapId);
    } catch (error) {
      setStatus('error');
      setErrorMessage(getApiErrorMessage(error));
    }
  }, [clearGeometrySession, refreshPartitionStatus]);

  useEffect(() => { void loadMapBundle(initialMapId); }, [initialMapId, loadMapBundle]);

  // Map initialization
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current || !mapboxToken) return;

    const preset = getViewPreset(mapForm.viewPresetId);
    const initialCenter: [number, number] = currentMap
      ? [currentMap.centerLng, currentMap.centerLat]
      : preset ? [preset.centerLng, preset.centerLat] : [-97.1384, 49.8951];

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      accessToken: mapboxToken,
      style: useBlankBasemap ? BLANK_STYLE : MAP_STYLE,
      center: initialCenter,
      zoom: currentMap?.defaultZoom ?? preset?.defaultZoom ?? 11,
      performanceMetricsCollection: false,
      attributionControl: false,
    });

    const draw = new MapboxDraw({
      displayControlsDefault: false,
      styles: createDrawStyles(),
    });
    mapRef.current = map;
    drawRef.current = draw;
    if (import.meta.env.DEV) {
      (window as unknown as { __adminMap?: mapboxgl.Map }).__adminMap = map;
    }
    map.addControl(draw, 'top-right');
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new mapboxgl.ScaleControl({ unit: 'metric', maxWidth: 120 }), 'bottom-right');

    // Snap indicator marker
    const snapEl = document.createElement('div');
    Object.assign(snapEl.style, {
      width: '14px', height: '14px',
      background: '#c8b48a',
      border: '2.5px solid #6b4220',
      borderRadius: '50%',
      transform: 'translate(-50%, -50%)',
      pointerEvents: 'none',
      display: 'none',
      boxShadow: '0 0 0 4px rgba(200,180,138,0.3)',
    });
    const snapMarker = new mapboxgl.Marker({ element: snapEl, anchor: 'center' });
    snapMarkerRef.current = snapMarker;

    const handleMapClick = (event: mapboxgl.MapMouseEvent) => {
      if (modeRef.current === 'draw' || modeRef.current === 'split' || modeRef.current === 'boundaries' || Date.now() < suppressZoneSelectionUntilRef.current) {
        return;
      }

      if (draftActiveRef.current || !map.isStyleLoaded()) return;

      const feature = map.queryRenderedFeatures(event.point, {
        layers: [MAP_FILL_LAYER_ID, MAP_LINE_LAYER_ID, MAP_LABEL_LAYER_ID],
      })[0];
      const zoneId = typeof feature?.properties?.id === 'string' ? feature.properties.id : null;
      if (!zoneId) return;

      const zone = zonesRef.current.find((z) => z.id === zoneId) ?? null;
      if (!zone) return;

      // Merge pick mode: second zone click
      if (mergePickModeRef.current && zoneId !== selectedZoneIdRef.current) {
        setMergeTargetId(zoneId);
        setIsMergePickMode(false);
        setNotice({ tone: 'info', message: `Merge target: "${zone.name}". Confirm or pick a different zone.` });
        return;
      }

      focusZone(zone);
    };

    const handleDrawCreate = (event: { features: Array<Feature> }) => {
      const feature = event.features[0];
      if (!feature?.geometry) return;

      const currentMode = modeRef.current;

      // Split mode: line drawn → execute split immediately
      if (currentMode === 'split') {
        const zoneId = splitZoneIdRef.current;
        if (!zoneId) { drawRef.current?.deleteAll(); setMode('select'); return; }
        drawRef.current?.deleteAll();
        suppressZoneSelectionUntilRef.current = Date.now() + 450;
        setMode('select');
        splitZoneIdRef.current = null;
        setIsSplitting(true);
        const lineGeometry = feature.geometry as GeoJsonGeometry;
        void splitMapZone(zoneId, lineGeometry)
          .then((splitZones) => {
            setZones((prev) => [...prev.filter((z) => z.id !== zoneId), ...splitZones]);
            setSelectedZoneId(splitZones[0]?.id ?? null);
            if (splitZones[0]) setZoneForm(buildFormFromZone(splitZones[0]));
            if (splitZones[0]) void refreshPartitionStatus(splitZones[0].mapId);
            setNotice({ tone: 'success', message: `Zone split into ${splitZones.length} parts.` });
          })
          .catch((error: unknown) => {
            setNotice({ tone: 'error', message: getApiErrorMessage(error) });
          })
          .finally(() => setIsSplitting(false));
        return;
      }

      // Draw mode: new polygon → snap nearby vertices. The server subtracts all
      // existing zone coverage, so only uncovered area becomes the new zone.
      modeRef.current = 'select';
      setMode('select');
      setSelectedZoneId(null);

      let geometry = feature.geometry as GeoJsonGeometry;
      if (geometry.type === 'Polygon') {
        geometry = snapPolygonVertices(geometry, zonesRef.current, map, SNAP_THRESHOLD_PX);
      }

      drawRef.current?.deleteAll();
      const [draftFeatureId] = drawRef.current?.add({
        type: 'Feature',
        id: 'draft-zone',
        properties: {},
        geometry: geometry as never,
      }) ?? [];

      draftActiveRef.current = true;
      setGeometryDraft(geometry);
      setZoneForm({ ...INITIAL_ZONE_FORM });
      if (draftFeatureId) {
        drawRef.current?.changeMode('direct_select', { featureId: String(draftFeatureId) });
      }
      setNotice({
        tone: 'info',
        message: 'Polygon ready. Drag vertices to reshape it, drag an amber midpoint to add a vertex, or select a vertex and press Delete/Backspace. Confirm when the outline is ready.',
      });
    };

    const handleDrawUpdate = (event: { features: Array<Feature> }) => {
      const feature = event.features[0];
      if (!feature?.geometry || feature.id !== 'draft-zone') return;
      setGeometryDraft(feature.geometry as GeoJsonGeometry);
    };

    const handleDrawDelete = (event: { features: Array<Feature> }) => {
      if (!draftActiveRef.current || !event.features.some((feature) => feature.id === 'draft-zone')) return;
      draftActiveRef.current = false;
      setGeometryDraft(null);
      setZoneForm({ ...INITIAL_ZONE_FORM });
      setNotice({ tone: 'info', message: 'Draft deleted. Choose Draw zone to start again.' });
    };

    const handleMouseMove = (event: mapboxgl.MapMouseEvent) => {
      if (!map.isStyleLoaded()) { map.getCanvas().style.cursor = ''; return; }
      if (modeRef.current === 'boundaries') return; // the boundary editor owns the cursor

      const isDrawing = modeRef.current === 'draw' || modeRef.current === 'split';
      const isMergePick = mergePickModeRef.current;

      // Snap indicator during draw/split modes
      if (isDrawing) {
        const nearest = findNearestZoneBoundaryPoint(event.lngLat.lng, event.lngLat.lat, zonesRef.current, map, SNAP_THRESHOLD_PX);
        if (nearest) {
          snapEl.style.display = 'block';
          snapMarker.setLngLat(nearest).addTo(map);
        } else {
          snapEl.style.display = 'none';
          snapMarker.remove();
        }
        map.getCanvas().style.cursor = 'crosshair';
        return;
      }

      snapEl.style.display = 'none';

      const feature = map.queryRenderedFeatures(event.point, {
        layers: [MAP_FILL_LAYER_ID, MAP_LINE_LAYER_ID, MAP_LABEL_LAYER_ID],
      })[0];

      if (isMergePick) {
        map.getCanvas().style.cursor = feature ? 'crosshair' : '';
      } else {
        map.getCanvas().style.cursor = feature ? 'pointer' : '';
      }
    };

    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = '';
      snapEl.style.display = 'none';
    };

    const handleLoad = () => {
      syncEditorSources(
        map,
        zonesRef.current,
        selectedZoneIdRef.current,
        mergeTargetIdRef.current,
        previewCollectionRef.current,
        new Set(),
        gapsRef.current,
        overlapRegionsRef.current,
      );
    };

    map.on('load', handleLoad);
    map.on('click', handleMapClick);
    map.on('mousemove', handleMouseMove);
    map.on('mouseleave', handleMouseLeave);
    map.on('draw.create', handleDrawCreate);
    map.on('draw.update', handleDrawUpdate);
    map.on('draw.delete', handleDrawDelete);

    return () => {
      map.off('load', handleLoad);
      map.off('click', handleMapClick);
      map.off('mousemove', handleMouseMove);
      map.off('mouseleave', handleMouseLeave);
      map.off('draw.create', handleDrawCreate);
      map.off('draw.update', handleDrawUpdate);
      map.off('draw.delete', handleDrawDelete);
      snapMarker.remove();
      snapMarkerRef.current = null;
      drawRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, [currentMap, focusZone, mapForm.viewPresetId]);

  useEffect(() => { syncMapSources(); }, [syncMapSources]);

  useEffect(() => {
    if (!mapRef.current || (didFitBoundsRef.current === true && !currentMap)) return;
    if (status !== 'ready') return;
    fitMapToCurrentData();
    didFitBoundsRef.current = true;
  }, [fitMapToCurrentData, currentMap, status]);

  useEffect(() => {
    const preset = getViewPreset(mapForm.viewPresetId);
    if (!preset || currentMap || zones.length > 0 || !mapRef.current) return;
    mapRef.current.flyTo({ center: [preset.centerLng, preset.centerLat], zoom: preset.defaultZoom, essential: true, duration: 650 });
  }, [currentMap, mapForm.viewPresetId, zones.length]);

  const sortedMaps = useMemo(() => [...maps].sort((a, b) => a.name.localeCompare(b.name)), [maps]);
  const zoneRows = useMemo(() => [...zones].sort((a, b) => a.name.localeCompare(b.name)), [zones]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleSelectMap = async (mapId: string) => {
    if (hasGeometrySession) {
      setNotice({ tone: 'info', message: 'Cancel the active geometry session before switching maps.' });
      return;
    }
    await loadMapBundle(mapId);
  };

  const handlePrepareNewMap = () => {
    if (hasGeometrySession) {
      setNotice({ tone: 'info', message: 'Cancel the active geometry session before starting a new map.' });
      return;
    }
    setCurrentMap(null);
    setZones([]);
    setIsDeleteMapArmed(false);
    setSelectedZoneId(null);
    setZoneForm(INITIAL_ZONE_FORM);
    setMapForm(INITIAL_MAP_FORM);
    setMergeTargetId(null);
    setIsMergePickMode(false);
    setPreviewCollection(null);
    setPreviewOrigin(null);
    if (typeof window !== 'undefined') window.history.replaceState({}, '', '/admin/zones');
  };

  const handleSelectRow = (zone: MapZone) => {
    if (hasGeometrySession) {
      setNotice({ tone: 'info', message: 'Cancel the active geometry session before switching zones.' });
      return;
    }
    // Merge pick mode: clicking a zone in list picks it as target
    if (isMergePickMode && zone.id !== selectedZoneId) {
      setMergeTargetId(zone.id);
      setIsMergePickMode(false);
      setNotice({ tone: 'info', message: `Merge target: "${zone.name}". Confirm or pick a different zone.` });
      return;
    }
    focusZone(zone);
  };

  const handleStartDraw = () => {
    if (!drawRef.current) return;
    if (!currentMap && !mapForm.name.trim()) {
      setNotice({ tone: 'info', message: 'Create a map before drawing zones.' });
      return;
    }
    clearGeometrySession();
    modeRef.current = 'draw';
    draftActiveRef.current = false;
    setMode('draw');
    setNotice({ tone: 'info', message: 'Click to place vertices; double-click to close. Drawing clicks will not select or zoom zones. Draw generously across existing zones; only uncovered area will become part of the new zone. After closing, you can edit the draft vertices before confirming.' });
    setSelectedZoneId(null);
    setIsDeleteArmed(false);
    setPreviewCollection(null);
    setPreviewOrigin(null);
    setMergeTargetId(null);
    setIsMergePickMode(false);
    drawRef.current?.deleteAll();
    setGeometryDraft(null);
    drawRef.current?.changeMode('draw_polygon');
  };

  const handleStartSplit = () => {
    if (!selectedZone || !drawRef.current) return;
    clearGeometrySession();
    splitZoneIdRef.current = selectedZone.id;
    suppressZoneSelectionUntilRef.current = Number.POSITIVE_INFINITY;
    setMode('split');
    setMergeTargetId(null);
    setIsMergePickMode(false);
    setIsDeleteArmed(false);
    drawRef.current.deleteAll();
    drawRef.current.changeMode('draw_line_string');
    setNotice({ tone: 'info', message: `Draw a line through "${selectedZone.name}" where you want it split. Double-click to finish.` });
  };

  const handleCancelGeometry = () => {
    clearGeometrySession();
    setNotice(null);
  };

  const handleStartBoundaryEdit = () => {
    const map = mapRef.current;
    if (!map || zones.length === 0) return;
    // isStyleLoaded() flickers false whenever tiles are pending; the editor
    // only needs the style object to exist so it can add its own layers.
    if (!map.getSource(MAP_SOURCE_ID)) {
      setNotice({ tone: 'info', message: 'The map is still loading — try again in a moment.' });
      return;
    }
    clearGeometrySession();
    setMode('boundaries');
    setIsDeleteArmed(false);
    setMergeTargetId(null);
    setIsMergePickMode(false);
    setPreviewCollection(null);
    setPreviewOrigin(null);

    const editor = new ZoneGraphEditor(
      map,
      zonesRef.current.map((zone) => ({ id: zone.id, name: zone.name, geometry: zone.geometry })),
      {
        onPreview: (geometries, changedZoneIds) => {
          setBoundaryPreview(geometries);
          setBoundaryChangedZoneIds(changedZoneIds);
        },
        onState: (state) => {
          setBoundarySelectedCount(state.selectedCount);
          setBoundaryCanUndo(state.canUndo);
          setBoundaryCanRedo(state.canRedo);
          setBoundaryHasSelfIntersections(state.hasSelfIntersections);
        },
        onNotice: (tone, message) => setNotice({ tone, message }),
      },
    );
    graphEditorRef.current = editor;

    const skipped = editor.skippedZoneIds.length;
    setNotice({
      tone: 'info',
      message: 'Boundary editing: every corner on the map is now a dot you can drag — shared corners move all their zones together, so no gaps can open. '
        + (skipped > 0 ? `${skipped} point zone${skipped === 1 ? '' : 's'} are not part of boundary editing. ` : '')
        + 'Save when you’re happy with the shape.',
    });
  };

  const handleSaveBoundaryEdit = async () => {
    const editor = graphEditorRef.current;
    if (!editor || !currentMap) return;
    if (boundaryHasSelfIntersections) {
      setNotice({ tone: 'error', message: 'Fix the red crossing point(s) before saving — a boundary can\'t cross itself.' });
      return;
    }
    const changed = editor.getChangedGeometries();
    if (changed.length === 0) {
      clearGeometrySession();
      setNotice({ tone: 'info', message: 'No boundary changes to save.' });
      return;
    }
    setIsSavingBoundaries(true);
    try {
      const nextZones = await updateMapZoneGeometries(currentMap.id, changed);
      setZones(nextZones);
      clearGeometrySession();
      void refreshPartitionStatus(currentMap.id);
      setNotice({ tone: 'success', message: `Saved boundary changes across ${changed.length} zone${changed.length === 1 ? '' : 's'}.` });
    } catch (error) {
      // Keep the session alive so the admin can fix the reported problem.
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsSavingBoundaries(false);
    }
  };

  const handleDeleteMap = async () => {
    if (!currentMap) return;
    if (hasGeometrySession) {
      setNotice({ tone: 'info', message: 'Cancel the active geometry session before deleting a map.' });
      return;
    }
    if (!isDeleteMapArmed) {
      setIsDeleteMapArmed(true);
      return;
    }

    setIsSavingMap(true);
    setNotice(null);
    try {
      const deletedMapId = currentMap.id;
      await deleteMapDefinition(deletedMapId);
      const remainingMaps = maps.filter((mapItem) => mapItem.id !== deletedMapId);
      const fallbackMapId = remainingMaps[0]?.id ?? null;
      setIsDeleteMapArmed(false);
      await loadMapBundle(fallbackMapId);
      setNotice({ tone: 'success', message: 'Map deleted.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsSavingMap(false);
    }
  };

  const handleSaveMap = async () => {
    let payload: MapUpsertInput;
    try {
      payload = buildMapPayload(mapForm, currentMap, {
        fallbackCenterLat: mapRef.current?.getCenter().lat,
        fallbackCenterLng: mapRef.current?.getCenter().lng,
        fallbackZoom: mapRef.current?.getZoom(),
      });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Invalid map details.' });
      return;
    }
    setIsSavingMap(true);
    setNotice(null);
    try {
      if (currentMap) {
        const updatedMap = await updateMapDefinition(currentMap.id, payload);
        setCurrentMap(updatedMap);
        setMaps((cur) => cur.map((m) => (m.id === updatedMap.id ? updatedMap : m)));
        setNotice({ tone: 'success', message: 'Map saved.' });
      } else {
        const createdMap = await createMapDefinition(payload);
        setMaps((cur) => [...cur, createdMap]);
        setCurrentMap(createdMap);
        setZones([]);
        setNotice({ tone: 'success', message: 'Map created. Start drawing zones.' });
      }
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsSavingMap(false);
    }
  };

  const handleSaveZone = async () => {
    if (!currentMap) {
      setNotice({ tone: 'error', message: 'Create or load a map before saving zones.' });
      return;
    }
    let payload: Omit<MapZoneUpsertInput, 'geometry'>;
    try {
      payload = buildZonePayload(zoneForm, selectedZone);
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Zone name is required.' });
      return;
    }
    setIsSavingZone(true);
    setNotice(null);
    try {
      if (geometryDraft && !selectedZone) {
        // Existing zones win every overlap; only uncovered draft area is created.
        const result = await createMapZoneCarving(currentMap.id, { ...payload, geometry: geometryDraft });
        setZones(result.zones);
        setSelectedZoneId(result.zone.id);
        setZoneForm(buildFormFromZone(result.zone));
        clearGeometrySession();
        fitMapToCurrentData(result.zone);
        void refreshPartitionStatus(currentMap.id);
        setNotice({
          tone: 'success',
          message: 'Zone created from uncovered area; existing zones were left unchanged.',
        });
        return;
      }
      if (!selectedZone) {
        setNotice({ tone: 'error', message: 'Select a zone or draw a polygon first.' });
        return;
      }
      // Update existing zone details (geometry changes go through boundary editing)
      const result = await updateMapZoneDefinition(selectedZone.id, payload);
      const updatedZoneById = new Map(result.zones.map((zone) => [zone.id, zone]));
      setZones((prev) => prev.map((zone) => updatedZoneById.get(zone.id) ?? zone));
      const updatedZone = result.zone;
      setZoneForm(buildFormFromZone(updatedZone));
      setNotice({ tone: 'success', message: 'Zone saved.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsSavingZone(false);
    }
  };

  const handleDeleteZone = async () => {
    if (!selectedZone) return;
    if (!isDeleteArmed) { setIsDeleteArmed(true); return; }
    setIsSavingZone(true);
    const deletedId = selectedZone.id;
    try {
      await deleteMapZoneDefinition(deletedId);
      const nextZones = zones.filter((z) => z.id !== deletedId);
      const nextSelected = nextZones[0]?.id ?? null;
      setZones(nextZones);
      setSelectedZoneId(nextSelected);
      if (nextZones[0]) setZoneForm(buildFormFromZone(nextZones[0]));
      setIsDeleteArmed(false);
      clearGeometrySession();
      setMergeTargetId(null);
      setIsMergePickMode(false);
      if (currentMap) void refreshPartitionStatus(currentMap.id);
      setNotice({
        tone: 'success',
        message: nextZones.length > 0
          ? 'Zone deleted. Its ground is unassigned now — use Edit Boundaries or Merge to give it to a neighbour.'
          : 'Zone deleted.',
      });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsSavingZone(false);
    }
  };

  const handlePreviewOsm = async () => {
    if (!currentMap) {
      setNotice({ tone: 'error', message: 'Create or load a map before requesting an OSM preview.' });
      return;
    }
    setIsPreviewLoading(true);
    try {
      const preview = await previewOsmMapZones(currentMap.id);
      setPreviewCollection(preview);
      setPreviewOrigin('osm');
      setNotice({ tone: 'info', message: `${preview.features.length} zones previewed from OSM. Review on the map, then Import.` });
      fitMapToPositions(mapRef.current, preview.features.flatMap((f) => collectGeometryPositions(f.geometry)), 96, 13.5);
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const handleImportPreview = async () => {
    if (!currentMap || !previewCollection) return;
    setIsImporting(true);
    try {
      const sanitized = sanitizeFeatureCollection(previewCollection);
      const importedZones = await importMapZoneDefinitions(currentMap.id, sanitized);
      setZones((prev) => [...prev, ...importedZones]);
      if (importedZones[0]) setSelectedZoneId(importedZones[0].id);
      setPreviewCollection(null);
      setPreviewOrigin(null);
      setNotice({ tone: 'success', message: `${importedZones.length} zones imported and saved.` });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsImporting(false);
    }
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      validateFeatureCollection(parsed);
      setPreviewCollection(parsed);
      setPreviewOrigin('file');
      const positions = parsed.features.flatMap((f: { geometry: GeoJsonGeometry }) => collectGeometryPositions(f.geometry));
      setNotice({ tone: 'info', message: `${parsed.features.length} features loaded. Review on the map, then Import.` });
      fitMapToPositions(mapRef.current, positions, 96, 13.5);
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to read GeoJSON file.' });
    } finally {
      event.target.value = '';
    }
  };

  const handleDropFile = async (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    const fakeEvent = { target: { files: [file], value: '' } } as unknown as ChangeEvent<HTMLInputElement>;
    await handleFileChange(fakeEvent);
  };

  const handleExportGeoJson = () => {
    if (!zones.length) { setNotice({ tone: 'error', message: 'No zones to export.' }); return; }
    const fileName = slugify(currentMap?.name ?? 'map') + '-zones.geojson';
    const blob = new Blob([JSON.stringify(buildZoneExport(zones), null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    setNotice({ tone: 'success', message: 'GeoJSON exported.' });
  };

  const handleStartMergePick = () => {
    if (!selectedZone) return;
    setIsMergePickMode(true);
    setMergeTargetId(null);
    setNotice({ tone: 'info', message: `Click another zone on the map or in the list to merge with "${selectedZone.name}".` });
  };

  const handleCancelMerge = () => {
    setIsMergePickMode(false);
    setMergeTargetId(null);
    setNotice(null);
  };

  const handleConfirmMerge = async () => {
    if (!currentMap || !selectedZoneId || !mergeTargetId) return;
    setIsMerging(true);
    try {
      const mergedZone = await mergeMapZones([selectedZoneId, mergeTargetId]);
      setZones((prev) => [...prev.filter((z) => z.id !== selectedZoneId && z.id !== mergeTargetId), mergedZone]);
      setSelectedZoneId(mergedZone.id);
      setZoneForm(buildFormFromZone(mergedZone));
      setMergeTargetId(null);
      setIsMergePickMode(false);
      void refreshPartitionStatus(currentMap.id);
      setNotice({ tone: 'success', message: 'Zones merged.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsMerging(false);
    }
  };

  const handleHealGaps = async () => {
    if (!currentMap) return;
    setIsHealingGaps(true);
    setNotice(null);
    try {
      const result = await healMapZoneGaps(currentMap.id, gapToleranceMeters);
      setZones(result.zones);
      setLastHealSkips(result.skippedGaps);
      void refreshPartitionStatus(currentMap.id);
      const parts: string[] = [];
      if (result.healedGapCount > 0) {
        parts.push(`Healed ${result.healedGapCount} boundary gap${result.healedGapCount === 1 ? '' : 's'}.`);
      }
      if (result.skippedGapCount > 0) {
        parts.push(`Skipped ${result.skippedGapCount} gap${result.skippedGapCount === 1 ? '' : 's'} — see "Why gaps were skipped" below for the reason each one failed.`);
      }
      if (parts.length === 0) {
        parts.push('No gaps found within the current search radius.');
      }
      setNotice({
        tone: result.healedGapCount > 0 && result.skippedGapCount === 0 ? 'success' : 'info',
        message: parts.join(' '),
      });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsHealingGaps(false);
    }
  };

  const handleResolveOverlap = async (trimZoneId: string, keepZoneId: string) => {
    if (!currentMap) return;
    const overlapKey = `${trimZoneId}-${keepZoneId}`;
    const trimZoneName = zones.find((z) => z.id === trimZoneId)?.name ?? 'zone';
    const keepZoneName = zones.find((z) => z.id === keepZoneId)?.name ?? 'the other zone';
    setResolvingOverlapKey(overlapKey);
    setNotice(null);
    try {
      const nextZones = await resolveMapZoneOverlap(currentMap.id, trimZoneId, keepZoneId);
      setZones(nextZones);
      void refreshPartitionStatus(currentMap.id);
      setNotice({ tone: 'success', message: `Trimmed "${trimZoneName}" back from "${keepZoneName}".` });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setResolvingOverlapKey(null);
    }
  };

  const selectedAnchor = selectedZone ? getZoneAnchor(selectedZone as unknown as RuntimeZone) : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-[#e8ece9] text-[#1f272a]">
      <div className="grid min-h-screen xl:grid-cols-[28rem_minmax(0,1fr)]">

        {/* ── Sidebar ── */}
        <aside className="border-b border-[#cad2d0] bg-[#f5f3ed] xl:border-b-0 xl:border-r xl:border-[#cad2d0]">
          <div className="flex h-full flex-col">

            {/* Header */}
            <div className="border-b border-[#d5d9d7] px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h1 className="text-2xl font-semibold tracking-[-0.02em] text-[#172022]">Map Editor</h1>
                  <p className="mt-0.5 text-sm text-[#596469]">Author reusable zone layouts.</p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadMapBundle(currentMap?.id ?? null)}
                  className="mt-1 rounded-full border border-[#b7bfbc] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-[#263033] transition hover:border-[#899492] hover:bg-white"
                >
                  ↺ Reload
                </button>
              </div>
            </div>

            {/* Scrollable panels */}
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">

              {/* Maps */}
              <Panel title="Maps">
                <div className="flex flex-wrap gap-2">
                  <ActionButton onClick={handlePrepareNewMap} label="New Map" tone="secondary" />
                  <ActionButton onClick={handleExportGeoJson} label="Export GeoJSON" tone="secondary" disabled={!zones.length} />
                </div>
                <div className="max-h-[15rem] space-y-2 overflow-y-auto pr-1">
                  {sortedMaps.map((mapItem) => (
                    <button
                      key={mapItem.id}
                      type="button"
                      onClick={() => void handleSelectMap(mapItem.id)}
                      className={[
                        'w-full rounded-2xl border px-3 py-3 text-left transition',
                        currentMap?.id === mapItem.id
                          ? 'border-[#72807d] bg-[#eef1ee] shadow-[0_8px_24px_rgba(45,58,60,0.08)]'
                          : 'border-[#d7ddda] bg-white hover:border-[#b6bfbc] hover:bg-[#fafaf8]',
                      ].join(' ')}
                    >
                      <p className="font-semibold text-[#172022]">{mapItem.name}</p>
                    </button>
                  ))}
                  {sortedMaps.length === 0 ? <p className="text-sm text-[#6a7478]">No authored maps yet.</p> : null}
                </div>
              </Panel>

              {/* Map Details */}
              <Panel title="Map Details">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Name">
                    <input
                      value={mapForm.name}
                      onChange={(e) => setMapForm((c) => ({ ...c, name: e.target.value }))}
                      className="w-full rounded-2xl border border-[#c4cac8] bg-white px-3 py-2 text-sm outline-none transition focus:border-[#8c9997]"
                    />
                  </Field>
                  <Field label="Starting View">
                    <select
                      value={mapForm.viewPresetId}
                      onChange={(e) => {
                        const nextId = e.target.value as ViewPresetId;
                        const preset = getViewPreset(nextId);
                        setMapForm((c) => ({ ...c, viewPresetId: nextId }));
                        if (preset && mapRef.current && !currentMap) {
                          mapRef.current.flyTo({ center: [preset.centerLng, preset.centerLat], zoom: preset.defaultZoom, duration: 650, essential: true });
                        }
                      }}
                      className="w-full rounded-2xl border border-[#c4cac8] bg-white px-3 py-2 text-sm outline-none transition focus:border-[#8c9997]"
                    >
                      {VIEW_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      <option value="custom">Custom</option>
                    </select>
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <ActionButton
                    onClick={() => void handleSaveMap()}
                    label={isSavingMap ? 'Saving…' : (currentMap ? 'Save Map' : 'Create Map')}
                    disabled={isSavingMap}
                  />
                  <ActionButton
                    onClick={() => void handleDeleteMap()}
                    label={isDeleteMapArmed ? 'Confirm Delete' : 'Delete Map'}
                    disabled={!currentMap || isSavingMap}
                    tone="danger"
                  />
                </div>
              </Panel>

              {/* Boundary Health */}
              {currentMap && zones.length > 0 ? (
                <Panel title="Boundary Health">
                  {gapReport.gaps.length === 0 ? (
                    <div className="flex items-center gap-2 rounded-2xl border border-[#bcd9c2] bg-[#eef7f0] px-3 py-2.5 text-sm text-[#2a6b3f]">
                      <span aria-hidden="true">✓</span>
                      <span>No adjacency gaps within {gapToleranceMeters}m.</span>
                    </div>
                  ) : (
                    <div className="space-y-2 rounded-2xl border border-[#e3b9a8] bg-[#fbf0eb] px-3 py-2.5 text-sm text-[#8a3a24]">
                      <p className="font-semibold">
                        {gapReport.gaps.length} boundary gap{gapReport.gaps.length === 1 ? '' : 's'} found
                      </p>
                      <p className="text-xs text-[#9a4e35]">
                        These zones look adjacent but their edges don&apos;t exactly touch — marked with red dots on the map.
                      </p>
                      <button
                        type="button"
                        onClick={() => setShowGapDetails((v) => !v)}
                        className="text-xs font-semibold uppercase tracking-[0.14em] text-[#8a3a24] underline underline-offset-2"
                      >
                        {showGapDetails ? 'Hide details' : 'Show details'}
                      </button>
                      {showGapDetails ? (
                        <ul className="max-h-32 space-y-1 overflow-y-auto rounded-xl border border-[#e3b9a8] bg-white px-2.5 py-2 text-xs text-[#5c3224]">
                          {gapReport.gaps.map((gap) => (
                            <li key={gap.id}>
                              {gap.zoneIds.map((id) => zones.find((z) => z.id === id)?.name ?? 'Unknown zone').join(' ↔ ')}
                              {' — '}{formatGapDistance(gap.gapMeters)}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  )}
                  <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                    <Field label="Search radius (m)">
                      <input
                        type="number"
                        min={0.1}
                        max={20}
                        step={0.1}
                        value={gapToleranceMeters}
                        onChange={(e) => {
                          const next = Number(e.target.value);
                          setGapToleranceMeters(Number.isFinite(next) && next > 0 ? next : DEFAULT_GAP_TOLERANCE_METERS);
                        }}
                        className="w-full rounded-2xl border border-[#c4cac8] bg-white px-3 py-2 text-sm outline-none transition focus:border-[#8c9997]"
                      />
                    </Field>
                    <ActionButton
                      onClick={() => void handleHealGaps()}
                      label={isHealingGaps ? 'Healing…' : 'Heal Gaps'}
                      disabled={isHealingGaps || gapReport.gaps.length === 0 || hasGeometrySession}
                    />
                  </div>

                  {lastHealSkips.length > 0 ? (
                    <div className="space-y-2 rounded-2xl border border-[#e3b9a8] bg-[#fbf0eb] px-3 py-2.5 text-sm text-[#8a3a24]">
                      <button
                        type="button"
                        onClick={() => setShowSkipDetails((v) => !v)}
                        className="text-xs font-semibold uppercase tracking-[0.14em] text-[#8a3a24] underline underline-offset-2"
                      >
                        {showSkipDetails ? 'Hide' : 'Why'} gaps were skipped ({lastHealSkips.length})
                      </button>
                      {showSkipDetails ? (
                        <ul className="max-h-40 space-y-1.5 overflow-y-auto rounded-xl border border-[#e3b9a8] bg-white px-2.5 py-2 text-xs text-[#5c3224]">
                          {lastHealSkips.map((skip, index) => (
                            <li key={index}>
                              <span className="font-semibold">
                                {skip.zoneIds.map((id) => zones.find((z) => z.id === id)?.name ?? 'Unknown zone').join(' ↔ ')}
                              </span>
                              {' — '}{skip.reason}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}

                  {partitionReport && partitionReport.overlaps.length > 0 ? (
                    <div className="space-y-2 rounded-2xl border border-[#c98d3a] bg-[#fdf3e2] px-3 py-2.5 text-sm text-[#7a4a10]">
                      <p className="font-semibold">
                        {partitionReport.overlaps.length} zone pair{partitionReport.overlaps.length === 1 ? '' : 's'} actually overlap
                      </p>
                      <p className="text-xs text-[#8f5f1c]">
                        Different from a boundary gap — these zones physically cover the same ground (shaded on the map), which is very likely why gap fixes involving them get skipped. Pick which zone gives up the shared area.
                      </p>
                      <ul className="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-[#c98d3a] bg-white px-2.5 py-2 text-xs text-[#5c3f14]">
                        {partitionReport.overlaps.map((overlap) => {
                          const trimAKey = `${overlap.zoneAId}-${overlap.zoneBId}`;
                          const trimBKey = `${overlap.zoneBId}-${overlap.zoneAId}`;
                          const isResolving = resolvingOverlapKey === trimAKey || resolvingOverlapKey === trimBKey;
                          return (
                            <li key={trimAKey} className="space-y-1.5 border-b border-[#f0ddb8] pb-1.5 last:border-b-0 last:pb-0">
                              <p>{overlap.zoneAName} ↔ {overlap.zoneBName} — {formatOverlapArea(overlap.overlapAreaSqMeters)}</p>
                              <div className="flex flex-wrap gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => void handleResolveOverlap(overlap.zoneAId, overlap.zoneBId)}
                                  disabled={isResolving}
                                  className="rounded-full border border-[#c98d3a] bg-[#fdf3e2] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#7a4a10] transition hover:bg-[#f7e6c4] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {resolvingOverlapKey === trimAKey ? 'Trimming…' : `Trim ${overlap.zoneAName}`}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleResolveOverlap(overlap.zoneBId, overlap.zoneAId)}
                                  disabled={isResolving}
                                  className="rounded-full border border-[#c98d3a] bg-[#fdf3e2] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#7a4a10] transition hover:bg-[#f7e6c4] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {resolvingOverlapKey === trimBKey ? 'Trimming…' : `Trim ${overlap.zoneBName}`}
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}

                  {isCheckingPartition ? <p className="text-xs text-[#6a7478]">Checking for overlaps…</p> : null}
                </Panel>
              ) : null}

              {/* Drawing Tools */}
              <Panel title="Tools">
                <div className="grid grid-cols-2 gap-2">
                  <ToolButton active={mode === 'select'} label="Select" onClick={() => { clearGeometrySession(); setNotice(null); }} />
                  <ToolButton active={mode === 'draw'} label="Draw Zone" onClick={handleStartDraw} />
                  <ToolButton
                    active={mode === 'boundaries'}
                    label="Edit Boundaries"
                    onClick={handleStartBoundaryEdit}
                    disabled={zones.length === 0 || Boolean(geometryDraft)}
                  />
                  <ToolButton
                    active={mode === 'split'}
                    label={isSplitting ? 'Splitting…' : 'Split Zone'}
                    onClick={handleStartSplit}
                    disabled={!selectedZone || isSplitting || hasGeometrySession}
                  />
                </div>
                {hasGeometrySession && mode !== 'boundaries' ? (
                  <ActionButton onClick={handleCancelGeometry} label="Cancel" tone="secondary" />
                ) : null}
                {mode === 'boundaries' ? (
                  <div className="space-y-2">
                    <ul className="space-y-1 rounded-2xl border border-[#d7ddda] bg-white px-3 py-2.5 text-xs text-[#4a5559]">
                      <li>· Drag a <strong>dot</strong> to move a corner — zones sharing it move together.</li>
                      <li>· <strong>Shift+drag</strong> the map to box-select dots, then drag one to move them all.</li>
                      <li>· Click a small <strong>hollow dot</strong> on an edge to add a corner there (both sides at once).</li>
                      <li>· Drop a dot onto another dot or edge to <strong>weld</strong> boundaries together.</li>
                      <li>· <strong>Delete</strong> removes selected corners · <strong>Ctrl+Z / Ctrl+Y</strong> undo &amp; redo · <strong>Esc</strong> clears the selection.</li>
                      <li>· Amber zones have unsaved boundary changes.</li>
                      <li>· Selecting a dot traces its <strong className="text-[#b3541e]">orange dashed</strong> boundary — since several zones can share one dot, this shows exactly whose edge you&apos;re moving.</li>
                    </ul>
                    {boundaryHasSelfIntersections ? (
                      <div className="rounded-2xl border border-[#d19c91] bg-[rgba(252,241,239,0.95)] px-3 py-2.5 text-xs text-[#6d3027]">
                        <span aria-hidden="true">●</span> This boundary now crosses itself (marked in red on the map). Undo or drag the corner back until the red dot disappears — a self-crossing shape can&apos;t be saved.
                      </div>
                    ) : null}
                    <div className="grid grid-cols-2 gap-2">
                      <ActionButton
                        onClick={() => void handleSaveBoundaryEdit()}
                        label={isSavingBoundaries
                          ? 'Saving…'
                          : boundaryChangedZoneIds.length > 0
                            ? `Save (${boundaryChangedZoneIds.length} zone${boundaryChangedZoneIds.length === 1 ? '' : 's'})`
                            : 'Save'}
                        disabled={isSavingBoundaries || boundaryHasSelfIntersections}
                      />
                      <ActionButton onClick={handleCancelGeometry} label="Discard" tone="secondary" disabled={isSavingBoundaries} />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <ActionButton onClick={() => graphEditorRef.current?.undo()} label="Undo" tone="secondary" disabled={!boundaryCanUndo} />
                      <ActionButton onClick={() => graphEditorRef.current?.redo()} label="Redo" tone="secondary" disabled={!boundaryCanRedo} />
                      <ActionButton
                        onClick={() => graphEditorRef.current?.deleteSelection()}
                        label={boundarySelectedCount > 0 ? `Delete (${boundarySelectedCount})` : 'Delete'}
                        tone="danger"
                        disabled={boundarySelectedCount === 0}
                      />
                    </div>
                  </div>
                ) : null}
              </Panel>

              {/* Selected Zone */}
              <Panel title={geometryDraft && !selectedZone ? 'New Zone' : 'Selected Zone'}>
                {!selectedZone && !geometryDraft ? (
                  <p className="text-sm text-[#6a7478]">Click a zone on the map or in the list below.</p>
                ) : null}

                {selectedZone ? (
                  <div className="rounded-2xl border border-[#d7ddda] bg-white px-3 py-3 text-sm">
                    <p className="font-semibold text-[#182123]">{selectedZone.name}</p>
                    {selectedAnchor ? (
                      <p className="mt-0.5 text-xs text-[#738085]">{selectedAnchor[1].toFixed(5)}, {selectedAnchor[0].toFixed(5)}</p>
                    ) : null}
                  </div>
                ) : null}

                {geometryDraft && !selectedZone ? (
                  <p className="text-xs text-[#6a7478]">New polygon captured. Enter a name and save.</p>
                ) : null}

                <Field label="Name">
                  <input
                    value={zoneForm.name}
                    onChange={(e) => setZoneForm((c) => ({ ...c, name: e.target.value }))}
                    placeholder="Zone name"
                    className="w-full rounded-2xl border border-[#c4cac8] bg-white px-3 py-2 text-sm outline-none transition focus:border-[#8c9997]"
                  />
                </Field>

                <div className="grid grid-cols-2 gap-2">
                  <ActionButton
                    onClick={() => void handleSaveZone()}
                    label={isSavingZone ? 'Saving…' : (geometryDraft && !selectedZone ? 'Create Zone' : 'Save Zone')}
                    disabled={isSavingZone || (!selectedZone && !geometryDraft) || mode === 'boundaries'}
                  />
                  <ActionButton
                    onClick={() => void handleDeleteZone()}
                    label={isDeleteArmed ? 'Confirm Delete' : 'Delete'}
                    disabled={!selectedZone || isSavingZone || mode === 'boundaries'}
                    tone="danger"
                  />
                </div>

                {selectedZone ? (
                  <div className="grid grid-cols-2 gap-2">
                    <ActionButton
                      onClick={handleStartBoundaryEdit}
                      label="Edit Boundaries"
                      disabled={hasGeometrySession}
                      tone="secondary"
                    />
                    <ActionButton
                      onClick={handleStartSplit}
                      label={isSplitting ? 'Splitting…' : 'Split Zone'}
                      disabled={isSplitting || hasGeometrySession}
                      tone="secondary"
                    />
                  </div>
                ) : null}

                {/* Merge controls */}
                {selectedZone && !hasGeometrySession ? (
                  <div className="space-y-2">
                    {!isMergePickMode && !mergeTargetId ? (
                      <ActionButton onClick={handleStartMergePick} label="Merge with…" tone="secondary" disabled={isMerging} />
                    ) : null}
                    {isMergePickMode ? (
                      <div className="space-y-2 rounded-2xl border border-[#d4dbd7] bg-[#f0f3f1] px-3 py-3">
                        <p className="text-xs font-semibold text-[#3d5055]">Click another zone on the map or list</p>
                        <ActionButton onClick={handleCancelMerge} label="Cancel" tone="secondary" />
                      </div>
                    ) : null}
                    {!isMergePickMode && mergeTargetZone ? (
                      <div className="space-y-2 rounded-2xl border border-[#c0d3da] bg-[#edf4f7] px-3 py-3">
                        <p className="text-xs font-semibold text-[#2a5060]">
                          Merge: <span className="text-[#182123]">{selectedZone.name}</span> + <span className="text-[#182123]">{mergeTargetZone.name}</span>
                        </p>
                        <div className="flex gap-2">
                          <ActionButton onClick={() => void handleConfirmMerge()} label={isMerging ? 'Merging…' : 'Confirm Merge'} disabled={isMerging} />
                          <ActionButton onClick={handleCancelMerge} label="Cancel" tone="secondary" />
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </Panel>

              {/* Import */}
              <Panel title="Import">
                <div className="space-y-3">
                  <label className="block">
                    <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-[#677174]">From OSM</span>
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm text-[#596467]">{currentMap?.name ?? 'Save the map first'}</span>
                      <ActionButton
                        onClick={() => void handlePreviewOsm()}
                        label={isPreviewLoading ? 'Loading…' : 'Preview'}
                        disabled={isPreviewLoading || !currentMap}
                      />
                    </div>
                  </label>

                  <input ref={fileInputRef} type="file" accept=".geojson,.json" className="hidden" onChange={(e) => void handleFileChange(e)} />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => void handleDropFile(e)}
                    className="flex w-full flex-col items-center justify-center rounded-2xl border border-dashed border-[#b9c1bf] bg-white px-4 py-5 text-center text-sm transition hover:border-[#8d9996] hover:bg-[#fafaf8]"
                  >
                    <span className="font-semibold text-[#1f2a2d]">Import GeoJSON</span>
                    <span className="mt-1 text-xs text-[#6a7478]">Drop a FeatureCollection here or click to choose a file.</span>
                  </button>

                  {previewCollection ? (
                    <div className="rounded-2xl border border-[#d4dad7] bg-white px-3 py-3 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold text-[#182123]">Preview ready</p>
                          <p className="mt-0.5 text-xs text-[#6a7478]">{previewCollection.features.length} features · {previewOrigin === 'osm' ? 'OSM' : 'file'}</p>
                        </div>
                        <div className="flex gap-2">
                          <ActionButton onClick={() => setPreviewCollection(null)} label="Clear" tone="secondary" />
                          <ActionButton
                            onClick={() => void handleImportPreview()}
                            label={isImporting ? 'Importing…' : 'Import'}
                            disabled={isImporting || !currentMap}
                          />
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </Panel>

              {/* Zone list */}
              <Panel title={`Zones${zones.length ? ` (${zones.length})` : ''}`}>
                {zones.length > 0 ? (
                  <p className="text-xs text-[#6a7478]">
                    {isMergePickMode ? 'Click a zone to pick it as the merge target.' : 'Click to select. Running games inherit this layout at game start.'}
                  </p>
                ) : null}
                <div className="max-h-[22rem] space-y-1.5 overflow-y-auto pr-1">
                  {zoneRows.map((zone) => {
                    const isSelected = selectedZoneId === zone.id;
                    const isMergeTarget = mergeTargetId === zone.id;
                    return (
                      <button
                        key={zone.id}
                        type="button"
                        onClick={() => handleSelectRow(zone)}
                        className={[
                          'w-full rounded-2xl border px-3 py-2.5 text-left transition',
                          isSelected
                            ? 'border-[#72807d] bg-[#eef1ee] shadow-[0_6px_18px_rgba(45,58,60,0.08)]'
                            : isMergeTarget
                              ? 'border-[#5a9db8] bg-[#eaf4f8]'
                              : isMergePickMode && !isSelected
                                ? 'border-[#b8cfd6] bg-white hover:border-[#5a9db8] hover:bg-[#eaf4f8]'
                                : 'border-[#d7ddda] bg-white hover:border-[#b6bfbc] hover:bg-[#fafaf8]',
                        ].join(' ')}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-semibold text-[#172022]">{zone.name}</p>
                          {isMergeTarget ? (
                            <span className="rounded-full bg-[#c0dce8] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#1e5a72]">Merge</span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                  {zoneRows.length === 0 ? <p className="text-sm text-[#6a7478]">No zones yet. Draw a polygon or import a GeoJSON file.</p> : null}
                </div>
              </Panel>

            </div>
          </div>
        </aside>

        {/* ── Map ── */}
        <section className="relative min-h-[55vh] bg-[#cfd7d6] xl:min-h-screen">
          {!mapboxToken ? (
            <div className="flex h-full items-center justify-center px-6">
              <div className="max-w-md rounded-[1.75rem] border border-[#c7cecb] bg-[#f8f5ef] px-6 py-5 text-center shadow-[0_18px_48px_rgba(31,42,47,0.12)]">
                <h2 className="mt-2 text-xl font-semibold text-[#182123]">Map token required</h2>
                <p className="mt-3 text-sm text-[#5f6b70]">Set VITE_MAPBOX_ACCESS_TOKEN in the repo root .env file.</p>
              </div>
            </div>
          ) : (
            <>
              <div ref={mapContainerRef} className="absolute inset-0" />
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 px-4 py-4">
                <div className="pointer-events-auto rounded-full border border-[#d8ddda] bg-[rgba(248,246,240,0.96)] px-4 py-2 text-sm text-[#243033] shadow-[0_12px_30px_rgba(35,48,52,0.16)] backdrop-blur">
                  {currentMap ? currentMap.name : 'Map Editor'}
                  {mode === 'draw' ? <span className="ml-2 text-[#8e6b2d]">· Drawing</span> : null}
                  {mode === 'split' ? <span className="ml-2 text-[#3d7a8a]">· Split Line</span> : null}
                  {mode === 'boundaries' ? <span className="ml-2 text-[#8e6b2d]">· Editing boundaries{boundaryChangedZoneIds.length > 0 ? ` (${boundaryChangedZoneIds.length} changed)` : ''}</span> : null}
                  {isMergePickMode ? <span className="ml-2 text-[#2a5870]">· Pick merge target</span> : null}
                </div>
                {notice ? (
                  <div className={[
                    'pointer-events-auto max-w-md rounded-2xl border px-4 py-3 text-sm shadow-[0_14px_34px_rgba(27,36,39,0.16)] backdrop-blur',
                    notice.tone === 'success' ? 'border-[#8fb29c] bg-[rgba(238,247,240,0.95)] text-[#1e4730]' : '',
                    notice.tone === 'error' ? 'border-[#d19c91] bg-[rgba(252,241,239,0.95)] text-[#6d3027]' : '',
                    notice.tone === 'info' ? 'border-[#bec9c5] bg-[rgba(246,245,241,0.96)] text-[#324146]' : '',
                  ].join(' ')}>
                    {notice.message}
                  </div>
                ) : null}
              </div>
              {status === 'loading' ? <MapStatusCard title="Loading" body="Fetching maps and zone geometry." /> : null}
              {status === 'error' ? <MapStatusCard title="Editor unavailable" body={errorMessage ?? 'Failed to load editor data.'} /> : null}
            </>
          )}
        </section>
      </div>
    </main>
  );
}

// ── UI components ─────────────────────────────────────────────────────────────

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-[0.22em] text-[#515c5f]">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.18em] text-[#677174]">{label}</span>
      {children}
    </label>
  );
}

function ActionButton({
  label, onClick, disabled = false, tone = 'primary',
}: {
  label: string; onClick: () => void; disabled?: boolean; tone?: 'primary' | 'secondary' | 'danger';
}) {
  const toneClass = tone === 'primary'
    ? 'border-[#1f2a2d] bg-[#1f2a2d] text-white hover:bg-[#151d1f]'
    : tone === 'danger'
      ? 'border-[#8d3f33] bg-[#8d3f33] text-white hover:bg-[#783126]'
      : 'border-[#c0c7c5] bg-white text-[#2d393d] hover:border-[#899492] hover:bg-[#fafaf8]';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] transition',
        toneClass,
        disabled ? 'cursor-not-allowed opacity-45' : '',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function ToolButton({
  active, label, onClick, disabled = false,
}: {
  active: boolean; label: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'rounded-2xl border px-3 py-3 text-center text-sm font-semibold transition',
        active
          ? 'border-[#7c8a87] bg-[#eef1ee] text-[#162022] shadow-[0_10px_24px_rgba(43,57,60,0.08)]'
          : 'border-[#d7ddda] bg-white text-[#324044] hover:border-[#b7c0bd] hover:bg-[#fafaf8]',
        disabled ? 'cursor-not-allowed opacity-45' : '',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function MapStatusCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
      <div className="pointer-events-auto max-w-md rounded-[1.75rem] border border-[#d7ddd9] bg-[rgba(247,245,239,0.95)] px-6 py-5 text-center shadow-[0_18px_48px_rgba(31,42,47,0.16)] backdrop-blur">
        <h2 className="text-xl font-semibold text-[#182123]">{title}</h2>
        <p className="mt-3 text-sm text-[#5f6b70]">{body}</p>
      </div>
    </div>
  );
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function findNearestZoneBoundaryPoint(
  lng: number, lat: number,
  zones: MapZone[],
  map: mapboxgl.Map,
  thresholdPx: number,
): [number, number] | null {
  const pt = map.project([lng, lat]);
  let best: [number, number] | null = null;
  let bestDist = thresholdPx;

  for (const zone of zones) {
    for (const ring of collectBoundaryRings(zone.geometry)) {
      for (let index = 1; index < ring.length; index += 1) {
        const [startLng, startLat] = ring[index - 1];
        const [endLng, endLat] = ring[index];
        const start = map.project([startLng, startLat]);
        const end = map.project([endLng, endLat]);
        const deltaX = end.x - start.x;
        const deltaY = end.y - start.y;
        const lengthSquared = (deltaX * deltaX) + (deltaY * deltaY);
        const projection = lengthSquared === 0
          ? 0
          : Math.min(1, Math.max(0, (((pt.x - start.x) * deltaX) + ((pt.y - start.y) * deltaY)) / lengthSquared));
        const projectedX = start.x + (projection * deltaX);
        const projectedY = start.y + (projection * deltaY);
        const distance = Math.hypot(projectedX - pt.x, projectedY - pt.y);

        if (distance < bestDist) {
          bestDist = distance;
          best = [
            startLng + (projection * (endLng - startLng)),
            startLat + (projection * (endLat - startLat)),
          ];
        }
      }
    }
  }

  return best;
}

function snapPolygonVertices(
  geometry: GeoJsonGeometry,
  zones: MapZone[],
  map: mapboxgl.Map,
  thresholdPx: number,
): GeoJsonGeometry {
  if (geometry.type !== 'Polygon') return geometry;
  return {
    ...geometry,
    coordinates: geometry.coordinates.map((ring) =>
      ring.map(([lng, lat]) => {
        const snapped = findNearestZoneBoundaryPoint(lng, lat, zones, map, thresholdPx);
        return (snapped ?? [lng, lat]) as [number, number];
      }),
    ),
  };
}

function collectBoundaryRings(geometry: GeoJsonGeometry): Array<Array<[number, number]>> {
  if (geometry.type === 'Polygon') {
    return geometry.coordinates as Array<Array<[number, number]>>;
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flat() as Array<Array<[number, number]>>;
  }
  return [];
}

// ── Map layer management ──────────────────────────────────────────────────────

function syncEditorSources(
  map: mapboxgl.Map,
  zones: MapZone[],
  selectedZoneId: string | null,
  mergeTargetId: string | null,
  previewCollection: GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> | null,
  synchronizedZoneIds: Set<string> = new Set(),
  gaps: AdjacencyGap[] = [],
  overlapRegions: GeoJsonGeometry[] = [],
): void {
  ensureEditorLayers(map);
  (map.getSource(MAP_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)
    ?.setData(buildZoneCollection(zones, selectedZoneId, mergeTargetId, synchronizedZoneIds));
  (map.getSource(PREVIEW_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)
    ?.setData(toPreviewFeatureCollection(previewCollection));
  (map.getSource(GAP_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)
    ?.setData(buildGapCollection(gaps));
  (map.getSource(OVERLAP_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)
    ?.setData(buildOverlapCollection(overlapRegions));
}

function ensureEditorLayers(map: mapboxgl.Map): void {
  if (!map.getSource(MAP_SOURCE_ID)) {
    map.addSource(MAP_SOURCE_ID, { type: 'geojson', data: emptyFeatureCollection() });
  }
  if (!map.getSource(PREVIEW_SOURCE_ID)) {
    map.addSource(PREVIEW_SOURCE_ID, { type: 'geojson', data: emptyFeatureCollection() });
  }
  if (!map.getSource(GAP_SOURCE_ID)) {
    map.addSource(GAP_SOURCE_ID, { type: 'geojson', data: emptyFeatureCollection() });
  }
  if (!map.getSource(OVERLAP_SOURCE_ID)) {
    map.addSource(OVERLAP_SOURCE_ID, { type: 'geojson', data: emptyFeatureCollection() });
  }

  if (!map.getLayer(MAP_FILL_LAYER_ID)) {
    map.addLayer({
      id: MAP_FILL_LAYER_ID, type: 'fill', source: MAP_SOURCE_ID,
      filter: ['==', '$type', 'Polygon'],
      paint: {
        'fill-color': ['coalesce', ['get', 'fillColor'], NEUTRAL_FILL],
        'fill-opacity': ['coalesce', ['get', 'fillOpacity'], 0.22],
      },
    });
  }
  if (!map.getLayer(MAP_LINE_LAYER_ID)) {
    map.addLayer({
      id: MAP_LINE_LAYER_ID, type: 'line', source: MAP_SOURCE_ID,
      paint: {
        'line-color': ['coalesce', ['get', 'lineColor'], NEUTRAL_LINE],
        'line-width': 2,
        'line-opacity': 0.92,
      },
    });
  }
  if (!map.getLayer(MAP_SELECTED_LAYER_ID)) {
    map.addLayer({
      id: MAP_SELECTED_LAYER_ID, type: 'line', source: MAP_SOURCE_ID,
      filter: ['==', ['get', 'selected'], 1],
      paint: { 'line-color': '#142024', 'line-width': 4, 'line-dasharray': [1, 1.5], 'line-opacity': 0.95 },
    });
  }
  if (!map.getLayer(MAP_LABEL_LAYER_ID)) {
    map.addLayer({
      id: MAP_LABEL_LAYER_ID, type: 'symbol', source: MAP_SOURCE_ID,
      layout: {
        'text-field': ['get', 'name'], 'text-size': 12,
        'text-font': ['IBM Plex Mono SemiBold', 'DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
        'text-allow-overlap': true, 'text-ignore-placement': true,
      },
      paint: { 'text-color': '#213036', 'text-halo-color': 'rgba(248,246,240,0.85)', 'text-halo-width': 1.2 },
    });
  }
  if (!map.getLayer(PREVIEW_FILL_LAYER_ID)) {
    map.addLayer({
      id: PREVIEW_FILL_LAYER_ID, type: 'fill', source: PREVIEW_SOURCE_ID,
      filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': '#c59c4f', 'fill-opacity': 0.16 },
    });
  }
  if (!map.getLayer(PREVIEW_LINE_LAYER_ID)) {
    map.addLayer({
      id: PREVIEW_LINE_LAYER_ID, type: 'line', source: PREVIEW_SOURCE_ID,
      paint: { 'line-color': '#986d26', 'line-width': 2.5, 'line-dasharray': [1.5, 1.25] },
    });
  }
  if (!map.getLayer(PREVIEW_LABEL_LAYER_ID)) {
    map.addLayer({
      id: PREVIEW_LABEL_LAYER_ID, type: 'symbol', source: PREVIEW_SOURCE_ID,
      layout: {
        'text-field': ['coalesce', ['get', 'name'], 'Preview'], 'text-size': 11,
        'text-font': ['IBM Plex Mono Medium', 'DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
        'text-allow-overlap': true, 'text-ignore-placement': true,
      },
      paint: { 'text-color': '#7b561a', 'text-halo-color': 'rgba(248,246,240,0.85)', 'text-halo-width': 1 },
    });
  }
  if (!map.getLayer(OVERLAP_FILL_LAYER_ID)) {
    map.addLayer({
      id: OVERLAP_FILL_LAYER_ID, type: 'fill', source: OVERLAP_SOURCE_ID,
      paint: {
        'fill-color': OVERLAP_COLOR,
        'fill-opacity': 0.35,
        'fill-outline-color': OVERLAP_COLOR,
      },
    });
  }
  if (!map.getLayer(OVERLAP_LINE_LAYER_ID)) {
    map.addLayer({
      id: OVERLAP_LINE_LAYER_ID, type: 'line', source: OVERLAP_SOURCE_ID,
      paint: { 'line-color': OVERLAP_COLOR, 'line-width': 2, 'line-dasharray': [1, 1] },
    });
  }
  if (!map.getLayer(GAP_HALO_LAYER_ID)) {
    map.addLayer({
      id: GAP_HALO_LAYER_ID, type: 'circle', source: GAP_SOURCE_ID,
      paint: {
        'circle-radius': 12,
        'circle-color': GAP_COLOR,
        'circle-opacity': 0.22,
      },
    });
  }
  if (!map.getLayer(GAP_DOT_LAYER_ID)) {
    map.addLayer({
      id: GAP_DOT_LAYER_ID, type: 'circle', source: GAP_SOURCE_ID,
      paint: {
        'circle-radius': 4.5,
        'circle-color': GAP_COLOR,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
      },
    });
  }
}

function buildZoneCollection(
  zones: MapZone[],
  selectedZoneId: string | null,
  mergeTargetId: string | null,
  synchronizedZoneIds: Set<string> = new Set(),
): FeatureCollection<GeoJsonGeometry, GeoJsonProperties> {
  return {
    type: 'FeatureCollection',
    features: zones.map((zone) => {
      const isMergeTarget = zone.id === mergeTargetId;
      const isSynchronized = synchronizedZoneIds.has(zone.id);
      return {
        type: 'Feature',
        id: zone.id,
        geometry: buildRenderedZoneGeometry(zone as unknown as RuntimeZone) as never,
        properties: {
          id: zone.id,
          name: zone.name,
          selected: zone.id === selectedZoneId ? 1 : 0,
          fillColor: zone.isDisabled ? '#d7dbd4' : (isMergeTarget ? MERGE_TARGET_FILL : (isSynchronized ? '#d8c89f' : NEUTRAL_FILL)),
          lineColor: isMergeTarget ? MERGE_TARGET_LINE : (zone.isDisabled ? '#9aa39e' : (isSynchronized ? '#8f6b24' : NEUTRAL_LINE)),
          fillOpacity: zone.isDisabled ? 0.08 : (isMergeTarget || isSynchronized ? 0.3 : 0.22),
        },
      } satisfies Feature<GeoJsonGeometry, GeoJsonProperties>;
    }),
  };
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function sanitizeGeometry(geometry: GeoJsonGeometry): GeoJsonGeometry {
  return { type: geometry.type, coordinates: (geometry as { type: string; coordinates: unknown }).coordinates } as GeoJsonGeometry;
}

function sanitizeFeatureCollection(
  collection: GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject>,
): GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> {
  return {
    type: 'FeatureCollection',
    features: collection.features.map((f) => ({
      type: 'Feature' as const,
      geometry: sanitizeGeometry(f.geometry),
      properties: f.properties ?? {},
    })),
  };
}

function buildZoneExport(zones: MapZone[]): GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> {
  return {
    type: 'FeatureCollection',
    features: zones.map((zone) => ({
      type: 'Feature',
      id: zone.id,
      geometry: zone.geometry,
      properties: {
        name: zone.name,
        pointValue: zone.pointValue,
        claimRadiusMeters: zone.claimRadiusMeters,
        maxGpsErrorMeters: zone.maxGpsErrorMeters,
        isDisabled: zone.isDisabled,
        metadata: zone.metadata,
      },
    })),
  };
}

function toPreviewFeatureCollection(
  collection: GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> | null,
): FeatureCollection<GeoJsonGeometry, GeoJsonProperties> {
  if (!collection) return emptyFeatureCollection();
  return {
    type: 'FeatureCollection',
    features: collection.features.map((f, i) => ({
      type: 'Feature',
      id: f.id ?? i,
      geometry: f.geometry as never,
      properties: f.properties ?? {},
    })),
  };
}

function emptyFeatureCollection(): FeatureCollection<GeoJsonGeometry, GeoJsonProperties> {
  return { type: 'FeatureCollection', features: [] };
}

function buildGapCollection(gaps: AdjacencyGap[]): FeatureCollection<GeoJsonGeometry, GeoJsonProperties> {
  return {
    type: 'FeatureCollection',
    features: gaps.map((gap) => ({
      type: 'Feature',
      id: gap.id,
      geometry: { type: 'Point', coordinates: gap.suggestedFix } as never,
      properties: { id: gap.id, zoneIds: gap.zoneIds.join(','), gapMeters: gap.gapMeters },
    })),
  };
}

function buildOverlapCollection(regions: GeoJsonGeometry[]): FeatureCollection<GeoJsonGeometry, GeoJsonProperties> {
  return {
    type: 'FeatureCollection',
    features: regions.map((geometry, index) => ({
      type: 'Feature',
      id: index,
      geometry: geometry as never,
      properties: {},
    })),
  };
}

function buildFormFromMap(map: MapDefinition): MapFormState {
  return { name: map.name, viewPresetId: inferPresetId(map) };
}

function buildFormFromZone(zone: MapZone): ZoneFormState {
  return { name: zone.name };
}

function buildMapPayload(
  form: MapFormState,
  currentMap: MapDefinition | null,
  fallback: { fallbackCenterLat?: number; fallbackCenterLng?: number; fallbackZoom?: number },
): MapUpsertInput {
  const name = form.name.trim();
  if (!name) throw new Error('Map name is required.');
  const preset = getViewPreset(form.viewPresetId);
  const centerLat = preset?.centerLat ?? currentMap?.centerLat ?? fallback.fallbackCenterLat;
  const centerLng = preset?.centerLng ?? currentMap?.centerLng ?? fallback.fallbackCenterLng;
  const defaultZoom = preset?.defaultZoom ?? currentMap?.defaultZoom ?? (fallback.fallbackZoom ? Math.round(fallback.fallbackZoom) : null);
  if (centerLat == null || centerLng == null || defaultZoom == null) {
    throw new Error('Choose a starting view or position the map before saving.');
  }
  return { name, centerLat, centerLng, defaultZoom, metadata: currentMap?.metadata ?? {} };
}

function buildZonePayload(form: ZoneFormState, selectedZone: MapZone | null): Omit<MapZoneUpsertInput, 'geometry'> {
  const name = form.name.trim();
  if (!name) throw new Error('Zone name is required.');
  return {
    name,
    pointValue: selectedZone?.pointValue ?? 1,
    claimRadiusMeters: selectedZone?.claimRadiusMeters ?? null,
    maxGpsErrorMeters: selectedZone?.maxGpsErrorMeters ?? null,
    isDisabled: selectedZone?.isDisabled ?? false,
    metadata: selectedZone?.metadata ?? {},
  };
}

function validateFeatureCollection(value: unknown): asserts value is GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> {
  if (!value || typeof value !== 'object' || (value as { type?: string }).type !== 'FeatureCollection') {
    throw new Error('File must contain a GeoJSON FeatureCollection.');
  }
  const features = (value as { features?: unknown }).features;
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error('FeatureCollection must contain at least one feature.');
  }
}

function fitMapToPositions(map: mapboxgl.Map | null, positions: Array<[number, number]>, padding: number, maxZoom = 15.8): void {
  if (!map || positions.length === 0) return;
  const bounds = positions.reduce(
    (b, p) => b.extend(p),
    new mapboxgl.LngLatBounds(positions[0], positions[0]),
  );
  map.fitBounds(bounds, { padding, maxZoom, duration: 650, essential: true });
}

function getViewPreset(id: ViewPresetId): ViewPreset | null {
  return VIEW_PRESETS.find((p) => p.id === id) ?? null;
}

function inferPresetId(map: MapDefinition): ViewPresetId {
  const preset = VIEW_PRESETS.find((candidate) =>
    Math.abs(candidate.centerLat - map.centerLat) < 0.01
    && Math.abs(candidate.centerLng - map.centerLng) < 0.01,
  );
  if (preset) return preset.id;
  return 'custom';
}

function getApiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error.';
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'map';
}

function formatGapDistance(meters: number): string {
  return meters < 1 ? `${Math.round(meters * 100)}cm` : `${meters.toFixed(1)}m`;
}

function formatOverlapArea(sqMeters: number): string {
  return sqMeters < 10000 ? `${Math.round(sqMeters)}m²` : `${(sqMeters / 10000).toFixed(2)}ha`;
}

function createDrawStyles(): object[] {
  return [
    { id: 'gl-draw-polygon-fill-inactive', type: 'fill', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']], paint: { 'fill-color': '#d9b163', 'fill-outline-color': '#8e6b2d', 'fill-opacity': 0.12 } },
    { id: 'gl-draw-polygon-fill-active', type: 'fill', filter: ['all', ['==', 'active', 'true'], ['==', '$type', 'Polygon']], paint: { 'fill-color': '#d9b163', 'fill-outline-color': '#8e6b2d', 'fill-opacity': 0.16 } },
    { id: 'gl-draw-polygon-stroke-inactive', type: 'line', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#8e6b2d', 'line-width': 2.4 } },
    { id: 'gl-draw-polygon-stroke-active', type: 'line', filter: ['all', ['==', 'active', 'true'], ['==', '$type', 'Polygon']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#8e6b2d', 'line-dasharray': [0.5, 1.2], 'line-width': 3 } },
    { id: 'gl-draw-line-active', type: 'line', filter: ['all', ['==', '$type', 'LineString'], ['==', 'active', 'true']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2a6a8a', 'line-dasharray': [0.5, 1.5], 'line-width': 2.8 } },
    { id: 'gl-draw-line-inactive', type: 'line', filter: ['all', ['==', '$type', 'LineString'], ['==', 'active', 'false']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2a6a8a', 'line-width': 2.2 } },
    { id: 'gl-draw-polygon-midpoint', type: 'circle', filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']], paint: { 'circle-radius': 4, 'circle-color': '#8e6b2d' } },
    { id: 'gl-draw-polygon-and-line-vertex-halo-active', type: 'circle', filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point'], ['!=', 'mode', 'static']], paint: { 'circle-radius': 7, 'circle-color': '#f7f5ef' } },
    { id: 'gl-draw-polygon-and-line-vertex-active', type: 'circle', filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point'], ['!=', 'mode', 'static']], paint: { 'circle-radius': 4.5, 'circle-color': '#8e6b2d' } },
  ] as object[];
}
