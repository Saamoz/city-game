import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { area as turfArea, bbox as turfBbox } from '@turf/turf';
import { formatArea } from '../../lib/units';
import type { GeoJsonMultiPolygon, GeoJsonPolygon, MapDefinition } from '@city-game/shared';

interface ChallengeAreaPickerProps {
  mapDefinition: MapDefinition | null;
  value: GeoJsonPolygon | GeoJsonMultiPolygon | null;
  onChange(area: GeoJsonPolygon | null): void;
}

const mapboxToken = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? import.meta.env.MAPBOX_ACCESS_TOKEN ?? '').trim();
const MAP_STYLE = 'mapbox://styles/saamoz/cmng3j80c004001s831aw5e3b';

// Draw the area a challenge can be done in: tap corners, tap the first corner to close.
// Once drawn, drag the corners to adjust.
export function ChallengeAreaPicker({ mapDefinition, value, onChange }: ChallengeAreaPickerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const [isDrawing, setIsDrawing] = useState(false);
  onChangeRef.current = onChange;
  valueRef.current = value;

  useEffect(() => {
    if (!containerRef.current || !mapDefinition || !mapboxToken) return;
    mapboxgl.accessToken = mapboxToken;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [mapDefinition.centerLng, mapDefinition.centerLat],
      zoom: mapDefinition.defaultZoom,
      attributionControl: false,
      dragRotate: false,
      touchPitch: false,
      pitchWithRotate: false,
      performanceMetricsCollection: false,
    });
    const draw = new MapboxDraw({ displayControlsDefault: false });
    map.addControl(draw);
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    drawRef.current = draw;

    const emit = () => {
      const feature = draw.getAll().features.find((entry) => entry.geometry.type === 'Polygon');
      onChangeRef.current(feature ? (feature.geometry as unknown as GeoJsonPolygon) : null);
    };
    const handleCreate = () => { setIsDrawing(false); emit(); };
    const handleModeChange = (event: { mode: string }) => { if (event.mode !== 'draw_polygon') setIsDrawing(false); };

    map.on('load', () => {
      const current = valueRef.current;
      if (current) {
        draw.add({ type: 'Feature', properties: {}, geometry: current as unknown as GeoJSON.Polygon });
        const [west, south, east, north] = turfBbox(current as unknown as GeoJSON.Polygon);
        map.fitBounds([[west, south], [east, north]], { padding: 40, maxZoom: 17, duration: 0 });
      }
    });
    map.on('draw.create', handleCreate);
    map.on('draw.update', emit);
    map.on('draw.delete', emit);
    map.on('draw.modechange', handleModeChange);

    return () => {
      map.remove();
      mapRef.current = null;
      drawRef.current = null;
    };
    // The map is rebuilt only when the source map changes; the area is loaded on creation.
  }, [mapDefinition]); // eslint-disable-line react-hooks/exhaustive-deps

  const startDrawing = () => {
    const draw = drawRef.current;
    if (!draw) return;
    draw.deleteAll();
    onChange(null);
    draw.changeMode('draw_polygon');
    setIsDrawing(true);
  };

  const clear = () => {
    drawRef.current?.deleteAll();
    drawRef.current?.changeMode('simple_select');
    setIsDrawing(false);
    onChange(null);
  };

  if (!mapDefinition) return <Notice body="Choose a source map before drawing an area." />;
  if (!mapboxToken) return <Notice body="Mapbox token required to draw an area." />;

  const sizeLabel = value ? formatArea(turfArea(value as unknown as GeoJSON.Polygon)) : null;
  return (
    <div className="overflow-hidden rounded-[1.25rem] border border-[#c8b48a]/55 bg-[#fff8eb]">
      <div ref={containerRef} className="h-72 w-full" />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#d6c59d]/55 px-4 py-3">
        <p className="text-xs leading-5 text-[#5a6a70]">
          {isDrawing ? 'Tap each corner, then tap the first corner to finish.' : value ? 'Area drawn (' + sizeLabel + '). Drag its corners to adjust.' : 'No area yet.'}
        </p>
        <div className="flex gap-2">
          <button className="rounded-full border border-[#24343a] bg-[#24343a] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[#f4ead7]" onClick={startDrawing} type="button">{value ? 'Redraw' : 'Draw area'}</button>
          {value || isDrawing ? <button className="rounded-full border border-[#c8b48a]/55 bg-white/70 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[#24343a]" onClick={clear} type="button">Clear</button> : null}
        </div>
      </div>
    </div>
  );
}

function Notice({ body }: { body: string }) {
  return <div className="rounded-[1.25rem] border border-dashed border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-5 text-sm leading-6 text-[#5a6a70]">{body}</div>;
}

