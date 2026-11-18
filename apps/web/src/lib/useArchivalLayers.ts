// Fetch-on-move for the archival tab (SPEC.md §7.2): 250 ms debounce, viewport padded 25% and snapped to
// the 0.05° grid, skip when the new view is inside the last fetched box, abort stale requests, 50-entry LRU.
// Hotspots mode draws detections (strongest 5000 in view); density mode switches 0.5° bins → 0.05° cells by zoom.
import { useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import type { FeatureCollection } from 'geojson';
import { api, isDetailMissing, type Bbox, type Level } from './api';
import { drawActivity, drawIndustrial, drawProne, setFireTheme } from './fireLayers';
import type { FireColoring, FireMode } from './mapSettings';

const snap = (v: number, up: boolean) => (up ? Math.ceil(v * 20) : Math.floor(v * 20)) / 20;
function paddedBbox(map: mapboxgl.Map): { padded: Bbox; raw: Bbox } {
  const b = map.getBounds()!;
  const w = Math.max(-180, b.getWest()), e = Math.min(180, b.getEast()), s = Math.max(-85, b.getSouth()), n = Math.min(85, b.getNorth());
  const dx = (e - w) * 0.25, dy = (n - s) * 0.25;
  return { raw: [w, s, e, n], padded: [snap(Math.max(-180, w - dx), false), snap(Math.max(-90, s - dy), false), snap(Math.min(180, e + dx), true), snap(Math.min(90, n + dy), true)] };
}
const inside = (a: Bbox, b: Bbox) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];
/** Shrink a box around its center to at most `maxDeg2` (the API's limit for that level). */
function clampArea(b: Bbox, maxDeg2: number): Bbox {
  const w = b[2] - b[0], h = b[3] - b[1];
  if (w * h <= maxDeg2) return b;
  const k = Math.sqrt(maxDeg2 / (w * h)) * 0.99, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  return [snap(cx - (w * k) / 2, true), snap(cy - (h * k) / 2, true), snap(cx + (w * k) / 2, false), snap(cy + (h * k) / 2, false)];
}
function toCentroids(fc: FeatureCollection): FeatureCollection {
  return { type: 'FeatureCollection', features: fc.features.map((f) => {
    const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
    return { type: 'Feature', properties: f.properties, geometry: { type: 'Point', coordinates: [(ring[0][0] + ring[2][0]) / 2, (ring[0][1] + ring[2][1]) / 2] } };
  }) };
}
const lru = new Map<string, FeatureCollection>();
function remember(k: string, v: FeatureCollection) {
  lru.delete(k);
  lru.set(k, v);
  if (lru.size > 50) lru.delete(lru.keys().next().value!);
}

export interface LayerState { loading: boolean; error: string | null; level: Level; truncated: boolean; count: number;
  /** The API has no detailed archive (summary-only load): fire layers are not drawn. */
  unavailable: boolean;
  /** realtime: VIIRS reference satellite per day (provenance for the freshness chip) */
  reference: Record<string, string | null> | null }
export interface LayerOptions {
  enabled: boolean;
  from: string;
  to: string;
  activity: boolean;
  mode: FireMode;
  sensor: 'all' | 'viirs' | 'modis' | 'none';
  coloring: FireColoring;
  prone: boolean;
  industrial: boolean;
  /** Dark basemap: fire colours flip so more/newer = brighter. */
  dark: boolean;
  /** Which store: archival (Postgres) or realtime (D1, last 92 days). */
  tier: 'archival' | 'realtime';
  /** Data version: a new ingest changes it, so cached layers are refetched. */
  version: number;
  /** Detailed archive loaded (from /api/meta); null while unknown. Fire and industrial layers need it. */
  detail: boolean | null;
}

export function useArchivalLayers(map: mapboxgl.Map | null, o: LayerOptions) {
  const [state, setState] = useState<LayerState>({ loading: false, error: null, level: 'coarse', truncated: false, count: 0, reference: null, unavailable: false });
  const last = useRef<{ key: string; box: Bbox } | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!map) return;
    if (!o.enabled) {
      drawActivity(map, null, 'points'); drawProne(map, null); drawIndustrial(map, null);
      last.current = null;
      return;
    }
    setFireTheme(o.dark);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      const z = map.getZoom();
      // activity: harmonized 0.5° bins → 0.05° cells; hotspots: harmonized active cells drawn as markers;
      // raw: the satellites' own detections (points) at z ≥ 3.
      const level: Level = o.mode === 'activity' ? (z <= 6 ? 'coarse' : 'cells') : z >= 3 ? (o.mode === 'raw' ? 'points' : 'cells') : 'coarse';
      const measure = o.mode === 'raw' ? 'raw' : 'harmonized';
      const { padded, raw } = paddedBbox(map);
      const sig = `${o.mode}|${level}|${o.from}|${o.to}|${o.activity}|${o.sensor}|${o.coloring}|${o.prone}|${o.industrial}|${o.dark}|${o.tier}|${o.version}|${o.detail}`;
      if (last.current && last.current.key === sig && inside(raw, last.current.box)) return; // small pan: nothing to fetch
      abort.current?.abort();
      const ac = (abort.current = new AbortController());
      setState((s) => ({ ...s, loading: true, error: null, level, unavailable: o.detail === false }));
      const box: Bbox = level === 'coarse' ? padded : clampArea(padded, o.mode === 'activity' ? 100 : 2500);
      const jobs: Promise<void>[] = [];
      const get = async (k: string, f: () => Promise<FeatureCollection>) => lru.get(k) ?? f().then((d) => (remember(k, d), d));
      const sensor = o.mode === 'raw' ? o.sensor : 'all';
      if (o.activity && sensor !== 'none' && o.detail)
        jobs.push(get(`a|${o.tier}|${o.version}|${o.mode}|${level}|${box}|${o.from}|${o.to}|${sensor}`, () => api.spots(box, level, o.from, o.to, 'fire', ac.signal, sensor, measure, o.tier)).then((d) => {
          // hotspots: one marker per active 5.5 km cell (sensor-independent), at the cell center
          const shown = o.mode === 'hotspots' && level === 'cells' ? toCentroids(d) : d;
          drawActivity(map, shown, level === 'points' || (o.mode === 'hotspots' && level === 'cells') ? 'points' : 'polygons', o.coloring, o.from, o.to);
          const m = (d as { meta?: { truncated: boolean; reference?: Record<string, string | null> } }).meta;
          setState((s) => ({ ...s, truncated: !!m?.truncated, count: d.features.length, reference: m?.reference ?? null }));
        }));
      else { drawActivity(map, null, 'points'); setState((s) => ({ ...s, truncated: false, count: 0 })); }
      if (o.prone) jobs.push(get(`p|${box}`, () => api.prone(box, ac.signal)).then((d) => drawProne(map, d)));
      else drawProne(map, null);
      const ilevel: Level = z >= 9 ? 'points' : 'cells';
      if (o.industrial && z >= 5 && o.detail) jobs.push(get(`i|${o.tier}|${o.version}|${ilevel}|${clampArea(padded, 100)}|${o.from}|${o.to}`, () => api.spots(clampArea(padded, ilevel === 'cells' ? 100 : 2500), ilevel, o.from, o.to, 'industrial', ac.signal, 'all', 'raw', o.tier)).then((d) => drawIndustrial(map, d)));
      else drawIndustrial(map, null);
      Promise.all(jobs)
        .then(() => { last.current = { key: sig, box }; setState((s) => ({ ...s, loading: false })); })
        .catch((e) => {
          if ((e as Error).name === 'AbortError') return;
          if (isDetailMissing(e)) { drawActivity(map, null, 'points'); drawIndustrial(map, null); setState((s) => ({ ...s, loading: false, unavailable: true })); return; }
          setState((s) => ({ ...s, loading: false, error: (e as Error).message })); // keep previous data on screen
        });
    };
    const onMove = () => { clearTimeout(timer); timer = setTimeout(run, 250); };
    const onStyle = () => { last.current = null; run(); };
    last.current = null;
    run();
    map.on('moveend', onMove);
    map.on('style.load', onStyle);
    return () => { clearTimeout(timer); map.off('moveend', onMove); map.off('style.load', onStyle); abort.current?.abort(); };
  }, [map, o.enabled, o.from, o.to, o.activity, o.mode, o.sensor, o.coloring, o.prone, o.industrial, o.dark, o.tier, o.version, o.detail]);

  return state;
}
