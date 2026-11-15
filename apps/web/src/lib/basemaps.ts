import type mapboxgl from 'mapbox-gl';
import type { FogSpecification } from 'mapbox-gl';
import type { LightPreset, MapSettings } from './mapSettings';

export type BasemapId = 'explore' | 'satellite' | 'terrain' | 'muted';

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

export const BASEMAP_ORDER: BasemapId[] = ['explore', 'satellite', 'terrain', 'muted'];

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
  }

  map.setFog(s.atmosphere ? FOG[preset] : null);
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
