import type mapboxgl from 'mapbox-gl';
import type { FogSpecification } from 'mapbox-gl';
import type { LightPreset, MapSettings } from './mapSettings';

export type BasemapId = 'dark' | 'explore' | 'satellite' | 'terrain' | 'muted';

/**
 * `standard` and `standard-satellite` are configured through the `basemap` import;
 * `classic` styles have no config, so details are toggled per layer.
 */
export type BasemapKind = 'standard' | 'standard-satellite' | 'classic';

interface Basemap {
  label: string;
  style: string;
  kind: BasemapKind;
  theme?: 'default' | 'monochrome';
}

export const BASEMAPS: Record<BasemapId, Basemap> = {
  dark: { label: 'Dark', style: 'mapbox://styles/mapbox/dark-v11', kind: 'classic' },
  explore: { label: 'Explore', style: 'mapbox://styles/mapbox/standard', kind: 'standard' },
  satellite: {
    label: 'Satellite',
    style: 'mapbox://styles/mapbox/standard-satellite',
    kind: 'standard-satellite',
  },
  terrain: {
    label: 'Terrain',
    style: 'mapbox://styles/mapbox/outdoors-v12',
    kind: 'classic',
  },
  muted: {
    label: 'Muted',
    style: 'mapbox://styles/mapbox/standard',
    kind: 'standard',
    theme: 'monochrome',
  },
};

export const BASEMAP_ORDER: BasemapId[] = ['dark', 'explore', 'satellite', 'terrain', 'muted'];

const FOG: Record<LightPreset, FogSpecification> = {
  day: {
    color: 'hsl(210, 60%, 92%)',
    'high-color': 'hsl(215, 80%, 56%)',
    'horizon-blend': 0.04,
    'space-color': 'hsl(225, 45%, 6%)',
    'star-intensity': 0.55,
  },
  dawn: {
    color: 'hsl(25, 80%, 86%)',
    'high-color': 'hsl(265, 55%, 52%)',
    'horizon-blend': 0.05,
    'space-color': 'hsl(250, 40%, 7%)',
    'star-intensity': 0.6,
  },
  dusk: {
    color: 'hsl(18, 70%, 72%)',
    'high-color': 'hsl(255, 50%, 38%)',
    'horizon-blend': 0.05,
    'space-color': 'hsl(245, 45%, 5%)',
    'star-intensity': 0.7,
  },
  night: {
    color: 'hsl(225, 35%, 18%)',
    'high-color': 'hsl(230, 60%, 24%)',
    'horizon-blend': 0.03,
    'space-color': 'hsl(230, 50%, 3%)',
    'star-intensity': 0.85,
  },
};

export function applyBasemap(map: mapboxgl.Map, s: MapSettings, preset: LightPreset) {
  const basemap = BASEMAPS[s.basemap];
  const set = (key: string, value: unknown) => map.setConfigProperty('basemap', key, value);

  if (basemap.kind === 'standard') {
    set('lightPreset', preset);
    set('theme', basemap.theme ?? 'default');
    set('showPlaceLabels', s.placeLabels);
    set('showRoadLabels', s.roadLabels);
    set('showAdminBoundaries', s.borders);
    set('show3dObjects', s.buildings3d);
    set('showPointOfInterestLabels', s.pois);
    set('showTransitLabels', false);
  } else if (basemap.kind === 'standard-satellite') {
    set('lightPreset', preset);
    set('showPlaceLabels', s.placeLabels);
    set('showRoadLabels', s.roadLabels);
    set('showAdminBoundaries', s.borders);
    set('showPointOfInterestLabels', s.pois);
    set('showTransitLabels', false);
  } else {
    applyClassicDetails(map, s);
    if (s.basemap === 'dark') applyFirmsLook(map);
  }

  // Fog/atmosphere only makes sense on the globe; the flat map stays clean.
  map.setFog(s.atmosphere && s.projection === 'globe' ? FOG[preset] : null);
}

function applyClassicDetails(map: mapboxgl.Map, s: MapSettings) {
  for (const layer of map.getStyle()?.layers ?? []) {
    let visible: boolean | undefined;
    if (layer.id.includes('admin')) visible = s.borders;
    else if (layer.type === 'symbol') {
      if (layer.id.startsWith('road')) visible = s.roadLabels;
      else if (layer.id.startsWith('poi')) visible = s.pois;
      else if (!layer.id.startsWith('overlay-')) visible = s.placeLabels;
    }
    if (visible !== undefined) {
      map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none');
    }
  }
}

/** FIRMS-like palette on top of dark-v11: grey land, darker ocean, thin light borders, small muted labels. */
const FIRMS = { land: '#2b2c2e', water: '#16181b', border: 'rgba(225,225,225,0.55)', label: '#8d9096', halo: 'rgba(10,10,12,0.85)' };
function applyFirmsLook(map: mapboxgl.Map) {
  const paint = (id: string, key: string, value: unknown) => {
    try { map.setPaintProperty(id, key as never, value as never); } catch { /* property not valid for this layer */ }
  };
  for (const layer of map.getStyle()?.layers ?? []) {
    const id = layer.id;
    if (id.startsWith('overlay-')) continue;
    if (layer.type === 'background') paint(id, 'background-color', FIRMS.land);
    else if (id === 'water' || id.startsWith('water-')) {
      if (layer.type === 'fill') paint(id, 'fill-color', FIRMS.water);
      if (layer.type === 'line') paint(id, 'line-color', FIRMS.water);
    } else if (layer.type === 'fill' && /^(land|landuse|national-park|landcover)/.test(id)) paint(id, 'fill-color', FIRMS.land);
    else if (layer.type === 'line' && id.startsWith('admin-0')) {
      paint(id, 'line-color', FIRMS.border);
      paint(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1]);
    } else if (layer.type === 'line' && id.startsWith('admin-1')) paint(id, 'line-color', 'rgba(225,225,225,0.22)');
    else if (layer.type === 'symbol' && !id.startsWith('road')) {
      paint(id, 'text-color', FIRMS.label);
      paint(id, 'text-halo-color', FIRMS.halo);
      // Smaller labels, scaled from the style's original size (cached, so re-applying is idempotent).
      let originals = ORIGINAL_SIZES.get(map);
      if (!originals) ORIGINAL_SIZES.set(map, (originals = new Map()));
      if (!originals.has(id)) originals.set(id, map.getLayoutProperty(id, 'text-size'));
      const scaled = scaleSize(originals.get(id), 0.85);
      if (scaled !== undefined) {
        try { map.setLayoutProperty(id, 'text-size', scaled as never); } catch { /* keep the style's size */ }
      }
    }
  }
}

const ORIGINAL_SIZES = new WeakMap<mapboxgl.Map, Map<string, unknown>>();
/** Multiplies a number, or the numeric outputs of a zoom interpolate/step, by k; undefined if unsupported. */
function scaleSize(v: unknown, k: number): unknown {
  if (typeof v === 'number') return v * k;
  if (!Array.isArray(v)) return undefined;
  if (v[0] === 'interpolate') return [...v.slice(0, 3), ...v.slice(3).map((x, i) => (i % 2 === 1 && typeof x === 'number' ? x * k : x))];
  if (v[0] === 'step') return [v[0], v[1], typeof v[2] === 'number' ? v[2] * k : v[2], ...v.slice(3).map((x, i) => (i % 2 === 1 && typeof x === 'number' ? x * k : x))];
  return undefined;
}
