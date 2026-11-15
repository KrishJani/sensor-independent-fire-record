// Measure tool: click to add points; double-click or Enter finishes; Esc cancels.
// Distances are great-circle (haversine) and areas geodesic (spherical excess on a 6371.0088 km sphere),
// so they stay correct at any zoom and latitude.
import { useCallback, useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import type { FeatureCollection, Polygon } from 'geojson';

export type MeasureMode = 'off' | 'distance' | 'area';
const R = 6371.0088; // km, mean Earth radius
const SRC = 'measure';
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceKm(pts: [number, number][]): number {
  let km = 0;
  for (let i = 1; i < pts.length; i++) {
    const [lon1, lat1] = pts[i - 1], [lon2, lat2] = pts[i];
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
    km += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return km;
}

/** Geodesic polygon area (km²) — the spherical-excess formula used by turf/area. */
export function areaKm2(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lon1, lat1] = ring[i], [lon2, lat2] = ring[(i + 1) % ring.length];
    s += rad(lon2 - lon1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((s * R * R) / 2);
}

export const fmtKm = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : km < 100 ? `${km.toFixed(2)} km` : `${Math.round(km).toLocaleString()} km`);
export const fmtArea = (km2: number) => `${km2 < 10 ? km2.toFixed(2) : Math.round(km2).toLocaleString()} km² (${Math.round(km2 * 100).toLocaleString()} ha)`;

function draw(map: mapboxgl.Map, pts: [number, number][], mode: MeasureMode, cursor: [number, number] | null) {
  const line = cursor ? [...pts, cursor] : pts;
  const fc: FeatureCollection = { type: 'FeatureCollection', features: [] };
  if (mode === 'area' && line.length >= 3) fc.features.push({ type: 'Feature', properties: { kind: 'area' }, geometry: { type: 'Polygon', coordinates: [[...line, line[0]]] } });
  if (line.length >= 2) fc.features.push({ type: 'Feature', properties: { kind: 'line' }, geometry: { type: 'LineString', coordinates: mode === 'area' && line.length >= 3 ? [...line, line[0]] : line } });
  for (const p of pts) fc.features.push({ type: 'Feature', properties: { kind: 'vertex' }, geometry: { type: 'Point', coordinates: p } });
  const src = map.getSource(SRC) as mapboxgl.GeoJSONSource | undefined;
  if (src) { src.setData(fc); return; }
  map.addSource(SRC, { type: 'geojson', data: fc });
  const slot = map.getStyle()?.imports?.length ? { slot: 'top' } : {};
  map.addLayer({ id: `${SRC}-fill`, type: 'fill', source: SRC, filter: ['==', ['get', 'kind'], 'area'], ...slot, paint: { 'fill-emissive-strength': 1, 'fill-color': '#ffffff', 'fill-opacity': 0.12 } } as mapboxgl.LayerSpecification);
  map.addLayer({ id: `${SRC}-line`, type: 'line', source: SRC, filter: ['==', ['get', 'kind'], 'line'], ...slot, paint: { 'line-emissive-strength': 1, 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 1.5] } } as mapboxgl.LayerSpecification);
  map.addLayer({ id: `${SRC}-vertex`, type: 'circle', source: SRC, filter: ['==', ['get', 'kind'], 'vertex'], ...slot, paint: { 'circle-emissive-strength': 1, 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': '#1f2937', 'circle-stroke-width': 1.5 } } as mapboxgl.LayerSpecification);
}
function clear(map: mapboxgl.Map) {
  for (const id of [`${SRC}-fill`, `${SRC}-line`, `${SRC}-vertex`]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SRC)) map.removeSource(SRC);
}

export function useMeasure(map: mapboxgl.Map | null) {
  const [mode, setMode] = useState<MeasureMode>('off');
  const [pts, setPts] = useState<[number, number][]>([]);
  const [done, setDone] = useState(false);
  const cursor = useRef<[number, number] | null>(null);

  const stop = useCallback(() => { setMode('off'); setPts([]); setDone(false); if (map) clear(map); }, [map]);

  useEffect(() => {
    if (!map || mode === 'off') return;
    map.doubleClickZoom.disable();
    map.getCanvas().style.cursor = 'crosshair';
    const onClick = (e: mapboxgl.MapMouseEvent) => { if (!done) setPts((p) => [...p, [e.lngLat.lng, e.lngLat.lat]]); };
    const onMove = (e: mapboxgl.MapMouseEvent) => { if (done) return; cursor.current = [e.lngLat.lng, e.lngLat.lat]; try { draw(map, ptsRef.current, mode, cursor.current); } catch { /* style loading */ } };
    // A double-click also fires two clicks on the same spot; drop those repeated vertices.
    const onDbl = () => { setPts((p) => p.filter((q, i) => i === 0 || Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) > 1e-9)); setDone(true); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stop(); if (e.key === 'Enter') setDone(true); };
    map.on('click', onClick);
    map.on('mousemove', onMove);
    map.on('dblclick', onDbl);
    window.addEventListener('keydown', onKey);
    return () => {
      map.off('click', onClick); map.off('mousemove', onMove); map.off('dblclick', onDbl);
      window.removeEventListener('keydown', onKey);
      map.doubleClickZoom.enable();
      map.getCanvas().style.cursor = '';
    };
  }, [map, mode, done, stop]);

  const ptsRef = useRef(pts);
  ptsRef.current = pts;
  useEffect(() => { if (map && mode !== 'off') try { draw(map, pts, mode, done ? null : cursor.current); } catch { /* style loading */ } }, [map, pts, mode, done]);

  const polygon: Polygon | null = mode === 'area' && done && pts.length >= 3 ? { type: 'Polygon', coordinates: [[...pts, pts[0]]] } : null;
  return {
    mode, done, points: pts,
    start: (m: Exclude<MeasureMode, 'off'>) => { if (map) clear(map); setPts([]); setDone(false); setMode(m); },
    stop,
    distance: distanceKm(mode === 'area' && pts.length >= 3 ? [...pts, pts[0]] : pts),
    area: mode === 'area' ? areaKm2(pts) : 0,
    polygon,
  };
}
