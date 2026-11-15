
// Fire data layers on the map. Colors (colorblind-safe):
//  hotspots  flame ramp yellow → orange → red → deep purple (by age, FRP, or sensor)
//  sensors   VIIRS orange #e8710a, MODIS blue #1f77b4 (distinct under common color-vision deficiencies)
//  prone     red ordinal ramp;  industrial heat  cool blue-grey (never read as fire)
import mapboxgl from 'mapbox-gl';
import type { FeatureCollection, Geometry } from 'geojson';
import type { FireColoring } from './mapSettings';

export const FIRE = 'fire-activity';
export const FIRE_POINTS = 'fire-points';
export const FIRE_GLOW = 'fire-glow';
export const PRONE = 'fire-prone';
export const INDUSTRIAL = 'industrial-heat';
export const REGIONS = 'harmonized-regions';

/** One ramp on every basemap (YlOrRd, low → high); see lib/colors.ts. */
/** FIRMS-like map dots: always red; older / lower is a slightly deeper red, newest / higher the brightest. */
export const FLAME: string[] = ['#8e1016', '#a3141a', '#b8181d', '#cc1d1f', '#e02422', '#f22e24', '#ff3b2b'];
export const FLAME_DARK = FLAME;
/** Crisp FIRMS-style dot: small at world scale, a little larger as you zoom in. */
const DOT_RADIUS = ['interpolate', ['exponential', 1.5], ['zoom'], 1, 1.3, 5, 2.2, 9, 3.6, 13, 6];

/** Centre and width (degrees) of a feature's bounding box (bins are axis-aligned squares). */
function centre(g: Geometry): [number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const visit = (c: unknown): void => {
    if (typeof (c as number[])[0] === 'number') {
      const [x, y] = c as number[];
      if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
    } else (c as unknown[]).forEach(visit);
  };
  if ('coordinates' in g) visit(g.coordinates);
  return [(w + e) / 2, (s + n) / 2, Math.max(0, e - w)];
}

let darkMap = false;
/** Set from the current basemap/light preset; the next draw uses the matching ramp. */
export function setFireTheme(dark: boolean) { darkMap = dark; }
/** Ramp ordered low → high for the current basemap. */
export const flameRamp = () => (darkMap ? FLAME_DARK : FLAME);
export const SENSOR_COLORS = { VIIRS: '#e8710a', MODIS: '#1f77b4' } as const;
export const PRONE_COLORS = { very_high: '#b2182b', high: '#ef8a62', elevated: '#fddbc7' } as const;
export const INDUSTRIAL_COLOR = '#6b7f99';

const slotFor = (map: mapboxgl.Map, top = false) => (map.getStyle()?.imports?.length ? { slot: top ? 'top' : 'middle' } : {});
function source(map: mapboxgl.Map, id: string, data: FeatureCollection) {
  const s = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
  if (s) s.setData(data);
  else map.addSource(id, { type: 'geojson', data });
}
function remove(map: mapboxgl.Map, ...ids: string[]) {
  for (const id of ids) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of ids) if (map.getSource(id)) map.removeSource(id);
}

/** Quantile breaks so the ramp adapts to whatever is in view. */
function breaks(values: number[], n: number): number[] {
  const xs = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!xs.length) return [1];
  const out: number[] = [];
  for (let i = 1; i < n; i++) out.push(xs[Math.min(xs.length - 1, Math.floor((i / n) * xs.length))]);
  return [...new Set(out)];
}
function step(prop: unknown, bs: number[], ramp: string[]) {
  const expr: unknown[] = ['step', prop, ramp[0]];
  // Spread the (deduplicated) breaks over the whole ramp so the top class always gets the top colour.
  bs.forEach((b, i) => expr.push(b, ramp[Math.round(((i + 1) * (ramp.length - 1)) / bs.length)]));
  return expr;
}

/** Point color: by age within the range (time), FRP (intensity) or sensor (simple). */
function pointColor(coloring: FireColoring): unknown {
  const R = flameRamp();
  if (coloring === 'sensor') return ['match', ['get', 'sensor'], 'VIIRS', SENSOR_COLORS.VIIRS, SENSOR_COLORS.MODIS];
  if (coloring === 'amount') return ['interpolate', ['linear'], ['get', 'harmonized_cell_days'], 0, R[0], 2, R[2], 6, R[4], 15, R[6]];
  if (coloring === 'intensity') return ['interpolate', ['linear'], ['get', 'frp_mw'], 0, R[0], 10, R[1], 50, R[3], 200, R[5], 1000, R[6]];
  // time: newest = the ramp's most salient end (white-hot on dark maps, deep on light), oldest = faintest; `age` is set in drawActivity
  return ['interpolate', ['linear'], ['get', 'age'], 0, R[6], 0.5, R[4], 1, R[1]];
}

export function drawActivity(map: mapboxgl.Map, data: FeatureCollection | null, kind: 'points' | 'polygons', coloring: FireColoring = 'recency', from = '', to = '') {
  if (!data) return remove(map, FIRE, FIRE_POINTS, FIRE_GLOW);
  if (kind === 'points') {
    remove(map, FIRE);
    // age in [0, 1] (0 = newest) for time-based coloring
    const t0 = Date.parse(from), t1 = Math.max(Date.parse(to), t0 + 86400000);
    for (const f of data.features) {
      const p = f.properties ?? (f.properties = {});
      p.age = 1 - Math.min(1, Math.max(0, (Date.parse(p.acq_date ?? p.last_seen) - t0) / (t1 - t0)));
    }
    source(map, FIRE_POINTS, data);
    const color = pointColor(coloring);
    remove(map, FIRE_GLOW); // FIRMS look: crisp dots, no halo
    if (!map.getLayer(FIRE_POINTS))
      map.addLayer({ id: FIRE_POINTS, type: 'circle', source: FIRE_POINTS, ...slotFor(map, true),
        paint: { 'circle-emissive-strength': 1, 'circle-radius': DOT_RADIUS,
          'circle-color': color, 'circle-stroke-width': 0, 'circle-pitch-alignment': 'map' } } as mapboxgl.LayerSpecification);
    else map.setPaintProperty(FIRE_POINTS, 'circle-color', color as never);
    return;
  }
  remove(map, FIRE_POINTS, FIRE_GLOW);
  // Coarse bins become red dots at the bin centre, sized (and slightly brightened) by intensity.
  // `w`: the bin's width in degrees, so each dot can be sized to fit inside its own cell at every zoom.
  const dots: FeatureCollection = { type: 'FeatureCollection', features: data.features.map((f) => { const c = centre(f.geometry); return { type: 'Feature', properties: { ...f.properties, w: c[2] }, geometry: { type: 'Point', coordinates: [c[0], c[1]] } }; }) };
  source(map, FIRE, dots);
  const R = flameRamp();
  // value: harmonized_cell_days (sensor-independent) or cell_days (raw / global layer)
  const val = ['coalesce', ['get', 'harmonized_cell_days'], ['get', 'cell_days']];
  const bs = breaks(data.features.map((f) => Number(f.properties?.harmonized_cell_days ?? f.properties?.cell_days ?? 0)), R.length);
  // Size class 0..n from the quantile breaks, then radius by zoom.
  const cls: unknown[] = ['step', val, 0];
  bs.forEach((b, i) => cls.push(b, i + 1));
  const k = ['/', cls, Math.max(1, bs.length)];
  // Radius in px = half the bin's on-screen width × (55%..95% by intensity), never below a visible 1.2 px.
  const perPx = (z: number) => ['*', ['coalesce', ['get', 'w'], 0.05], (512 * 2 ** z) / 360 / 2];
  const frac = ['+', 0.55, ['*', 0.4, k]];
  const radius = ['interpolate', ['exponential', 2], ['zoom'], 0, ['max', 1.2, ['*', frac, perPx(0)]], 16, ['max', 1.2, ['*', frac, perPx(16)]]];
  const color = step(val, bs, R);
  if (map.getLayer(FIRE) && map.getLayer(FIRE)!.type !== 'circle') map.removeLayer(FIRE);
  if (!map.getLayer(FIRE))
    map.addLayer({ id: FIRE, type: 'circle', source: FIRE, ...slotFor(map),
      paint: { 'circle-emissive-strength': 1, 'circle-radius': radius, 'circle-color': color, 'circle-opacity': 0.92, 'circle-stroke-width': 0, 'circle-pitch-alignment': 'map' } } as mapboxgl.LayerSpecification);
  else {
    map.setPaintProperty(FIRE, 'circle-color', color as never);
    map.setPaintProperty(FIRE, 'circle-radius', radius as never);
  }
}

export function drawProne(map: mapboxgl.Map, data: FeatureCollection | null) {
  if (!data) return remove(map, PRONE);
  source(map, PRONE, data);
  if (!map.getLayer(PRONE))
    map.addLayer({ id: PRONE, type: 'fill', source: PRONE, ...slotFor(map),
      paint: { 'fill-emissive-strength': 1, 'fill-color': ['match', ['get', 'prone_class'], 'very_high', PRONE_COLORS.very_high, 'high', PRONE_COLORS.high, PRONE_COLORS.elevated], 'fill-opacity': 0.5, 'fill-outline-color': 'rgba(120,20,30,0.3)' } } as mapboxgl.LayerSpecification);
}

export function drawIndustrial(map: mapboxgl.Map, data: FeatureCollection | null) {
  if (!data) return remove(map, INDUSTRIAL);
  source(map, INDUSTRIAL, data);
  const isPoint = data.features[0]?.geometry.type === 'Point';
  if (map.getLayer(INDUSTRIAL) && (map.getLayer(INDUSTRIAL)!.type === 'circle') !== isPoint) map.removeLayer(INDUSTRIAL);
  if (!map.getLayer(INDUSTRIAL))
    map.addLayer({ id: INDUSTRIAL, type: isPoint ? 'circle' : 'fill', source: INDUSTRIAL, ...slotFor(map, true),
      paint: isPoint
        ? { 'circle-emissive-strength': 1, 'circle-radius': 3.5, 'circle-color': INDUSTRIAL_COLOR, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 0.8 }
        : { 'fill-emissive-strength': 1, 'fill-color': INDUSTRIAL_COLOR, 'fill-opacity': 0.55 } } as mapboxgl.LayerSpecification);
}

export function drawRegions(map: mapboxgl.Map, regions: { id: string; name: string; bbox: [number, number, number, number] }[] | null) {
  if (!regions) return remove(map, REGIONS);
  const data: FeatureCollection = {
    type: 'FeatureCollection',
    features: regions.map((r) => {
      const [w, s, e, n] = r.bbox;
      return { type: 'Feature', properties: { id: r.id, name: r.name }, geometry: { type: 'LineString', coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] } };
    }),
  };
  source(map, REGIONS, data);
  if (!map.getLayer(REGIONS))
    map.addLayer({ id: REGIONS, type: 'line', source: REGIONS, ...slotFor(map, true), paint: { 'line-emissive-strength': 1, 'line-color': 'rgba(255,255,255,0.55)', 'line-width': 1, 'line-dasharray': [3, 2] } } as mapboxgl.LayerSpecification);
}
