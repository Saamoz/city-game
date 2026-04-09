import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, ReactNode } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import type { Feature, FeatureCollection, GeoJsonProperties, MultiPolygon, Polygon } from 'geojson';
import { difference as turfDifference, featureCollection, feature as turfFeature } from '@turf/turf';
import type {
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
  createMapZoneDefinition,
  deleteMapZoneDefinition,
  getMap,
  importMapZoneDefinitions,
  listMaps,
  listMapZones,
  mergeMapZones,
  previewOsmMapZones,
  splitMapZone,
  updateMapDefinition,
  updateMapZoneDefinition,
  type MapUpsertInput,
  type MapZoneUpsertInput,
} from '../../lib/api';
import { buildRenderedZoneGeometry, collectGeometryPositions, getZoneAnchor } from '../game/mapGeometry';

interface AdminZoneEditorProps {
  initialMapId: string | null;
}

type EditorMode = 'select' | 'draw' | 'split';
type NoticeTone = 'info' | 'success' | 'error';
type BaseCityId = 'toronto' | 'chicago' | 'custom';

interface NoticeState {
  tone: NoticeTone;
  message: string;
}

interface MapFormState {
  name: string;
  baseCityId: BaseCityId;
  city: string;
}

interface ZoneFormState {
  name: string;
}

interface CityPreset {
  id: Exclude<BaseCityId, 'custom'>;
  label: string;
  city: string;
  centerLat: number;
  centerLng: number;
  defaultZoom: number;
}

const mapboxToken = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? import.meta.env.MAPBOX_ACCESS_TOKEN ?? '').trim();
const MAP_STYLE = 'mapbox://styles/saamoz/cmng3j80c004001s831aw5e3b';
const MAP_SOURCE_ID = 'admin-maps-source';
const MAP_FILL_LAYER_ID = 'admin-maps-fill';
const MAP_LINE_LAYER_ID = 'admin-maps-line';
const MAP_SELECTED_LAYER_ID = 'admin-maps-selected';
const MAP_LABEL_LAYER_ID = 'admin-maps-label';
const PREVIEW_SOURCE_ID = 'admin-maps-preview-source';
const PREVIEW_FILL_LAYER_ID = 'admin-maps-preview-fill';
const PREVIEW_LINE_LAYER_ID = 'admin-maps-preview-line';
const PREVIEW_LABEL_LAYER_ID = 'admin-maps-preview-label';
const NEUTRAL_FILL = '#c8cdc5';
const NEUTRAL_LINE = '#667076';
const MERGE_TARGET_FILL = '#7ab0c8';
const MERGE_TARGET_LINE = '#2a6a8a';
const SNAP_THRESHOLD_PX = 18;

const CITY_PRESETS: CityPreset[] = [
  { id: 'toronto', label: 'Toronto', city: 'Toronto', centerLat: 43.6532, centerLng: -79.3832, defaultZoom: 11 },
  { id: 'chicago', label: 'Chicago', city: 'Chicago', centerLat: 41.8781, centerLng: -87.6298, defaultZoom: 11 },
];

const INITIAL_MAP_FORM: MapFormState = { name: '', baseCityId: 'toronto', city: CITY_PRESETS[0].city };
const INITIAL_ZONE_FORM: ZoneFormState = { name: '' };

export function AdminZoneEditor({ initialMapId }: AdminZoneEditorProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const snapMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const didFitBoundsRef = useRef(false);
  const zonesRef = useRef<MapZone[]>([]);
  const selectedZoneIdRef = useRef<string | null>(null);
  const previewCollectionRef = useRef<GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> | null>(null);
  const modeRef = useRef<EditorMode>('select');
  const splitZoneIdRef = useRef<string | null>(null);
  const suppressZoneSelectionUntilRef = useRef(0);
  const mergeTargetIdRef = useRef<string | null>(null);
  const mergePickModeRef = useRef(false);
  const editSessionRef = useRef<{ editingZoneId: string | null; draftActive: boolean }>({ editingZoneId: null, draftActive: false });

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
  const [editingGeometryZoneId, setEditingGeometryZoneId] = useState<string | null>(null);
  const [isSavingMap, setIsSavingMap] = useState(false);
  const [isSavingZone, setIsSavingZone] = useState(false);
  const [isDeleteArmed, setIsDeleteArmed] = useState(false);
  const [previewCollection, setPreviewCollection] = useState<GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> | null>(null);
  const [previewOrigin, setPreviewOrigin] = useState<'osm' | 'file' | null>(null);
  const [osmCity, setOsmCity] = useState('');
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isSplitting, setIsSplitting] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);
  const [isMergePickMode, setIsMergePickMode] = useState(false);

  const selectedZone = useMemo(() => zones.find((z) => z.id === selectedZoneId) ?? null, [selectedZoneId, zones]);
  const mergeTargetZone = useMemo(() => zones.find((z) => z.id === mergeTargetId) ?? null, [mergeTargetId, zones]);
  const hasGeometrySession = Boolean(geometryDraft) || Boolean(editingGeometryZoneId);

  // Sync refs
  useEffect(() => { zonesRef.current = zones; }, [zones]);
  useEffect(() => { selectedZoneIdRef.current = selectedZoneId; }, [selectedZoneId]);
  useEffect(() => { previewCollectionRef.current = previewCollection; }, [previewCollection]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { mergeTargetIdRef.current = mergeTargetId; }, [mergeTargetId]);
  useEffect(() => { mergePickModeRef.current = isMergePickMode; }, [isMergePickMode]);
  useEffect(() => {
    editSessionRef.current = { editingZoneId: editingGeometryZoneId, draftActive: Boolean(geometryDraft) };
  }, [editingGeometryZoneId, geometryDraft]);

  useEffect(() => {
    if (!currentMap) return;
    setMapForm(buildFormFromMap(currentMap));
    setOsmCity(currentMap.city ?? '');
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
    drawRef.current?.deleteAll();
    setGeometryDraft(null);
    setEditingGeometryZoneId(null);
    setMode('select');
    splitZoneIdRef.current = null;
    suppressZoneSelectionUntilRef.current = 0;
  }, []);

  const syncMapSources = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    syncEditorSources(map, zones, selectedZoneId, mergeTargetId, previewCollection);
  }, [mergeTargetId, previewCollection, selectedZoneId, zones]);

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
    const preset = getCityPreset(mapForm.baseCityId);
    if (currentMap) {
      map.flyTo({ center: [currentMap.centerLng, currentMap.centerLat], zoom: currentMap.defaultZoom, essential: true });
      return;
    }
    if (preset) {
      map.flyTo({ center: [preset.centerLng, preset.centerLat], zoom: preset.defaultZoom, essential: true });
    }
  }, [currentMap, mapForm.baseCityId, zones]);

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

  const loadMapBundle = useCallback(async (targetMapId?: string | null) => {
    setStatus('loading');
    setErrorMessage(null);
    setNotice(null);
    setPreviewCollection(null);
    setPreviewOrigin(null);
    setIsDeleteArmed(false);
    setMergeTargetId(null);
    setIsMergePickMode(false);
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
    } catch (error) {
      setStatus('error');
      setErrorMessage(getApiErrorMessage(error));
    }
  }, [clearGeometrySession]);

  useEffect(() => { void loadMapBundle(initialMapId); }, [initialMapId, loadMapBundle]);

  // Map initialization
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current || !mapboxToken) return;

    const preset = getCityPreset(mapForm.baseCityId);
    const initialCenter: [number, number] = currentMap
      ? [currentMap.centerLng, currentMap.centerLat]
      : preset ? [preset.centerLng, preset.centerLat] : [-97.1384, 49.8951];

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      accessToken: mapboxToken,
      style: MAP_STYLE,
      center: initialCenter,
      zoom: currentMap?.defaultZoom ?? preset?.defaultZoom ?? 11,
      performanceMetricsCollection: false,
      attributionControl: false,
    });

    const draw = new MapboxDraw({ displayControlsDefault: false, styles: createDrawStyles() });
    mapRef.current = map;
    drawRef.current = draw;
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
      if (modeRef.current === 'split' || Date.now() < suppressZoneSelectionUntilRef.current) {
        return;
      }

      if (editSessionRef.current.draftActive || editSessionRef.current.editingZoneId || !map.isStyleLoaded()) return;

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
            setNotice({ tone: 'success', message: `Zone split into ${splitZones.length} parts.` });
          })
          .catch((error: unknown) => {
            setNotice({ tone: 'error', message: getApiErrorMessage(error) });
          })
          .finally(() => setIsSplitting(false));
        return;
      }

      // Draw mode: new polygon → snap + clip
      setMode('select');
      setSelectedZoneId(null);
      setEditingGeometryZoneId(null);

      let geometry = feature.geometry as GeoJsonGeometry;

      // Snap drawn vertices to nearby existing zone boundaries
      if (geometry.type === 'Polygon') {
        geometry = snapPolygonVertices(geometry, zonesRef.current, map, SNAP_THRESHOLD_PX);
      }

      // Auto-clip against existing zones (prevent overlap)
      if ((geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') && zonesRef.current.length > 0) {
        try {
          const drawn = turfFeature(geometry as Polygon | MultiPolygon);
          const clipped = autoClipAgainstZones(drawn, zonesRef.current);
          if (clipped === null) {
            setNotice({ tone: 'error', message: 'The drawn area is fully covered by existing zones.' });
            drawRef.current?.deleteAll();
            return;
          }
          geometry = clipped.geometry as GeoJsonGeometry;
        } catch {
          // use unclipped geometry if turf fails
        }
      }

      // Show the (possibly modified) geometry in the draw tool
      drawRef.current?.deleteAll();
      drawRef.current?.add({ type: 'Feature', id: 'draft-zone', properties: {}, geometry: geometry as never });

      setGeometryDraft(geometry);
      setZoneForm({ ...INITIAL_ZONE_FORM });
      setNotice({ tone: 'info', message: 'Polygon ready — enter a name and click Create Zone.' });
    };

    const handleDrawUpdate = (event: { features: Array<Feature> }) => {
      const feature = event.features[0];
      if (!feature?.geometry) return;
      setGeometryDraft(feature.geometry as GeoJsonGeometry);
    };

    const handleMouseMove = (event: mapboxgl.MapMouseEvent) => {
      if (!map.isStyleLoaded()) { map.getCanvas().style.cursor = ''; return; }

      const isDrawing = modeRef.current === 'draw' || modeRef.current === 'split';
      const isMergePick = mergePickModeRef.current;

      // Snap indicator during draw/split modes
      if (isDrawing) {
        const nearest = findNearestZoneVertex(event.lngLat.lng, event.lngLat.lat, zonesRef.current, map, SNAP_THRESHOLD_PX);
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
      syncEditorSources(map, zonesRef.current, selectedZoneIdRef.current, mergeTargetIdRef.current, previewCollectionRef.current);
    };

    map.on('load', handleLoad);
    map.on('click', handleMapClick);
    map.on('mousemove', handleMouseMove);
    map.on('mouseleave', handleMouseLeave);
    map.on('draw.create', handleDrawCreate);
    map.on('draw.update', handleDrawUpdate);

    return () => {
      map.off('load', handleLoad);
      map.off('click', handleMapClick);
      map.off('mousemove', handleMouseMove);
      map.off('mouseleave', handleMouseLeave);
      map.off('draw.create', handleDrawCreate);
      map.off('draw.update', handleDrawUpdate);
      snapMarker.remove();
      snapMarkerRef.current = null;
      drawRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, [currentMap, focusZone, mapForm.baseCityId]);

  useEffect(() => { syncMapSources(); }, [syncMapSources]);

  useEffect(() => {
    if (!mapRef.current || (didFitBoundsRef.current === true && !currentMap)) return;
    if (status !== 'ready') return;
    fitMapToCurrentData();
    didFitBoundsRef.current = true;
  }, [fitMapToCurrentData, currentMap, status]);

  useEffect(() => {
    const preset = getCityPreset(mapForm.baseCityId);
    if (!preset || currentMap || zones.length > 0 || !mapRef.current) return;
    mapRef.current.flyTo({ center: [preset.centerLng, preset.centerLat], zoom: preset.defaultZoom, essential: true, duration: 650 });
  }, [currentMap, mapForm.baseCityId, zones.length]);

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
    setMode('draw');
    setNotice({ tone: 'info', message: 'Click to place vertices. Double-click to close the polygon. Amber dots indicate snap points on existing zone edges.' });
    setSelectedZoneId(null);
    setIsDeleteArmed(false);
    setPreviewCollection(null);
    setPreviewOrigin(null);
    setMergeTargetId(null);
    setIsMergePickMode(false);
    drawRef.current.deleteAll();
    setGeometryDraft(null);
    setEditingGeometryZoneId(null);
    drawRef.current.changeMode('draw_polygon');
  };

  const handleStartSplit = () => {
    if (!selectedZone || !drawRef.current) return;
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

  const handleBeginEditGeometry = () => {
    if (!selectedZone || !drawRef.current) return;
    clearGeometrySession();
    const featureId = drawRef.current.add({
      type: 'Feature',
      id: selectedZone.id,
      properties: {},
      geometry: selectedZone.geometry as never,
    });
    const drawFeatureId = Array.isArray(featureId) ? featureId[0] : featureId;
    drawRef.current.changeMode('direct_select', { featureId: drawFeatureId });
    setEditingGeometryZoneId(selectedZone.id);
    setGeometryDraft(selectedZone.geometry);
    setNotice({ tone: 'info', message: 'Drag vertices to reshape. Click a vertex then press Delete/Backspace to remove it. Save when done.' });
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
        // Create new zone
        const createdZone = await createMapZoneDefinition(currentMap.id, { ...payload, geometry: geometryDraft });
        setZones((prev) => [...prev, createdZone]);
        setSelectedZoneId(createdZone.id);
        setZoneForm(buildFormFromZone(createdZone));
        clearGeometrySession();
        fitMapToCurrentData(createdZone);
        setNotice({ tone: 'success', message: 'Zone created.' });
        return;
      }
      if (!selectedZone) {
        setNotice({ tone: 'error', message: 'Select a zone or draw a polygon first.' });
        return;
      }
      // Update existing zone
      const updatedZone = await updateMapZoneDefinition(selectedZone.id, {
        ...payload,
        geometry: editingGeometryZoneId === selectedZone.id && geometryDraft ? geometryDraft : undefined,
      });
      setZones((prev) => prev.map((z) => (z.id === updatedZone.id ? updatedZone : z)));
      setZoneForm(buildFormFromZone(updatedZone));
      clearGeometrySession();
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
      setNotice({ tone: 'success', message: 'Zone deleted.' });
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
    const city = osmCity.trim() || currentMap.city || '';
    if (!city) {
      setNotice({ tone: 'error', message: 'Enter a city name before requesting an OSM preview.' });
      return;
    }
    setIsPreviewLoading(true);
    try {
      const preview = await previewOsmMapZones(currentMap.id, city);
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
    const fileName = slugify((currentMap?.city ?? currentMap?.name ?? 'map')) + '-zones.geojson';
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
      setNotice({ tone: 'success', message: 'Zones merged.' });
    } catch (error) {
      setNotice({ tone: 'error', message: getApiErrorMessage(error) });
    } finally {
      setIsMerging(false);
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
                      <p className="mt-0.5 text-xs text-[#6a7478]">{mapItem.city ?? 'No city'}</p>
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
                  <Field label="Base City">
                    <select
                      value={mapForm.baseCityId}
                      onChange={(e) => {
                        const nextId = e.target.value as BaseCityId;
                        const preset = getCityPreset(nextId);
                        setMapForm((c) => ({ ...c, baseCityId: nextId, city: preset?.city ?? c.city }));
                        if (preset && mapRef.current && !currentMap) {
                          mapRef.current.flyTo({ center: [preset.centerLng, preset.centerLat], zoom: preset.defaultZoom, duration: 650, essential: true });
                        }
                      }}
                      className="w-full rounded-2xl border border-[#c4cac8] bg-white px-3 py-2 text-sm outline-none transition focus:border-[#8c9997]"
                    >
                      {CITY_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      <option value="custom">Custom</option>
                    </select>
                  </Field>
                </div>
                {mapForm.baseCityId === 'custom' ? (
                  <Field label="City Name">
                    <input
                      value={mapForm.city}
                      onChange={(e) => setMapForm((c) => ({ ...c, city: e.target.value }))}
                      placeholder="Custom city"
                      className="w-full rounded-2xl border border-[#c4cac8] bg-white px-3 py-2 text-sm outline-none transition focus:border-[#8c9997]"
                    />
                  </Field>
                ) : null}
                <ActionButton
                  onClick={() => void handleSaveMap()}
                  label={isSavingMap ? 'Saving…' : (currentMap ? 'Save Map' : 'Create Map')}
                  disabled={isSavingMap}
                />
              </Panel>

              {/* Drawing Tools */}
              <Panel title="Drawing">
                <div className="grid grid-cols-3 gap-2">
                  <ToolButton active={mode === 'select'} label="Select" onClick={() => { clearGeometrySession(); setNotice(null); }} />
                  <ToolButton active={mode === 'draw'} label="Draw Zone" onClick={handleStartDraw} />
                  <ToolButton
                    active={mode === 'split'}
                    label={isSplitting ? 'Splitting…' : 'Split Line'}
                    onClick={handleStartSplit}
                    disabled={!selectedZone || isSplitting || hasGeometrySession}
                  />
                </div>
                {hasGeometrySession ? (
                  <ActionButton onClick={handleCancelGeometry} label="Cancel" tone="secondary" />
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
                    disabled={isSavingZone || (!selectedZone && !geometryDraft)}
                  />
                  <ActionButton
                    onClick={() => void handleDeleteZone()}
                    label={isDeleteArmed ? 'Confirm Delete' : 'Delete'}
                    disabled={!selectedZone || isSavingZone}
                    tone="danger"
                  />
                </div>

                {selectedZone ? (
                  <div className="grid grid-cols-2 gap-2">
                    <ActionButton
                      onClick={handleBeginEditGeometry}
                      label="Edit Vertices"
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
                    <div className="flex gap-2">
                      <input
                        value={osmCity}
                        onChange={(e) => setOsmCity(e.target.value)}
                        placeholder={currentMap?.city ?? 'City name'}
                        className="min-w-0 flex-1 rounded-2xl border border-[#c4cac8] bg-white px-3 py-2 text-sm outline-none transition focus:border-[#8c9997]"
                      />
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

function findNearestZoneVertex(
  lng: number, lat: number,
  zones: MapZone[],
  map: mapboxgl.Map,
  thresholdPx: number,
): [number, number] | null {
  const pt = map.project([lng, lat]);
  let best: [number, number] | null = null;
  let bestDist = thresholdPx;
  for (const zone of zones) {
    for (const [vLng, vLat] of collectGeometryPositions(zone.geometry as unknown as RuntimeZone['geometry'])) {
      const vPt = map.project([vLng, vLat]);
      const dist = Math.hypot(vPt.x - pt.x, vPt.y - pt.y);
      if (dist < bestDist) { bestDist = dist; best = [vLng, vLat]; }
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
        const snapped = findNearestZoneVertex(lng, lat, zones, map, thresholdPx);
        return (snapped ?? [lng, lat]) as [number, number];
      }),
    ),
  };
}

function autoClipAgainstZones(
  drawnFeature: Feature<Polygon | MultiPolygon>,
  existingZones: MapZone[],
): Feature<Polygon | MultiPolygon> | null {
  let result: Feature<Polygon | MultiPolygon> = drawnFeature;
  for (const zone of existingZones) {
    if (zone.geometry.type !== 'Polygon' && zone.geometry.type !== 'MultiPolygon') continue;
    try {
      const clipped = turfDifference(featureCollection([
        result,
        turfFeature(zone.geometry as Polygon | MultiPolygon),
      ]));
      if (clipped === null) return null;
      result = clipped as Feature<Polygon | MultiPolygon>;
    } catch {
      // skip zones with invalid geometry
    }
  }
  return result;
}

// ── Map layer management ──────────────────────────────────────────────────────

function syncEditorSources(
  map: mapboxgl.Map,
  zones: MapZone[],
  selectedZoneId: string | null,
  mergeTargetId: string | null,
  previewCollection: GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> | null,
): void {
  ensureEditorLayers(map);
  (map.getSource(MAP_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)
    ?.setData(buildZoneCollection(zones, selectedZoneId, mergeTargetId));
  (map.getSource(PREVIEW_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)
    ?.setData(toPreviewFeatureCollection(previewCollection));
}

function ensureEditorLayers(map: mapboxgl.Map): void {
  if (!map.getSource(MAP_SOURCE_ID)) {
    map.addSource(MAP_SOURCE_ID, { type: 'geojson', data: emptyFeatureCollection() });
  }
  if (!map.getSource(PREVIEW_SOURCE_ID)) {
    map.addSource(PREVIEW_SOURCE_ID, { type: 'geojson', data: emptyFeatureCollection() });
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
}

function buildZoneCollection(
  zones: MapZone[],
  selectedZoneId: string | null,
  mergeTargetId: string | null,
): FeatureCollection<GeoJsonGeometry, GeoJsonProperties> {
  return {
    type: 'FeatureCollection',
    features: zones.map((zone) => {
      const isMergeTarget = zone.id === mergeTargetId;
      return {
        type: 'Feature',
        id: zone.id,
        geometry: buildRenderedZoneGeometry(zone as unknown as RuntimeZone) as never,
        properties: {
          id: zone.id,
          name: zone.name,
          selected: zone.id === selectedZoneId ? 1 : 0,
          fillColor: zone.isDisabled ? '#d7dbd4' : (isMergeTarget ? MERGE_TARGET_FILL : NEUTRAL_FILL),
          lineColor: isMergeTarget ? MERGE_TARGET_LINE : (zone.isDisabled ? '#9aa39e' : NEUTRAL_LINE),
          fillOpacity: zone.isDisabled ? 0.08 : (isMergeTarget ? 0.3 : 0.22),
        },
      } satisfies Feature<GeoJsonGeometry, GeoJsonProperties>;
    }),
  };
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function sanitizeFeatureCollection(
  collection: GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject>,
): GeoJsonFeatureCollection<GeoJsonGeometry, JsonObject> {
  return {
    type: 'FeatureCollection',
    features: collection.features.map((f) => ({
      type: 'Feature' as const,
      geometry: f.geometry,
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

function buildFormFromMap(map: MapDefinition): MapFormState {
  return { name: map.name, baseCityId: inferPresetId(map), city: map.city ?? '' };
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
  const preset = getCityPreset(form.baseCityId);
  const centerLat = preset?.centerLat ?? currentMap?.centerLat ?? fallback.fallbackCenterLat;
  const centerLng = preset?.centerLng ?? currentMap?.centerLng ?? fallback.fallbackCenterLng;
  const defaultZoom = preset?.defaultZoom ?? currentMap?.defaultZoom ?? (fallback.fallbackZoom ? Math.round(fallback.fallbackZoom) : null);
  if (centerLat == null || centerLng == null || defaultZoom == null) {
    throw new Error('Choose a built-in city or position the map before saving.');
  }
  return { name, city: preset?.city ?? (form.city.trim() || null), centerLat, centerLng, defaultZoom, metadata: currentMap?.metadata ?? {} };
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

function getCityPreset(id: BaseCityId): CityPreset | null {
  return CITY_PRESETS.find((p) => p.id === id) ?? null;
}

function inferPresetId(map: MapDefinition): BaseCityId {
  const city = (map.city ?? '').toLowerCase();
  if (city.includes('toronto')) return 'toronto';
  if (city.includes('chicago')) return 'chicago';
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
