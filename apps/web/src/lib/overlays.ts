import mapboxgl from 'mapbox-gl';
import type { Feature, FeatureCollection, GeoJSON, LineString } from 'geojson';
import { BASEMAPS } from './basemaps';
import type { LightPreset, MapSettings } from './mapSettings';
import { nightPolygon } from './sun';

const GRATICULE = 'overlay-graticule';
const TERMINATOR = 'overlay-terminator';

function line(coordinates: [number, number][], kind: string): Feature<LineString> {
  return { type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates } };
}

function graticule(step: number): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  for (let lat = -90 + step; lat < 90; lat += step) {
    const coords: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 2) coords.push([lon, lat]);
    features.push(line(coords, lat === 0 ? 'equator' : 'parallel'));
  }
  for (let lon = -180; lon < 180; lon += step) {
    const coords: [number, number][] = [];
    for (let lat = -85; lat <= 85; lat += 2) coords.push([lon, lat]);
    features.push(line(coords, 'meridian'));
  }
  return { type: 'FeatureCollection', features };
}

const GRATICULE_DATA = graticule(15);

function upsertGeoJson(
  map: mapboxgl.Map,
  id: string,
  data: GeoJSON | null,
  layer: { type: 'fill' | 'line'; paint: Record<string, unknown>; slot?: string },
) {
  const source = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;

  if (!data) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (source) map.removeSource(id);
    return;
  }

  if (source) {
    source.setData(data);
    for (const [key, value] of Object.entries(layer.paint)) {
      map.setPaintProperty(id, key as never, value as never);
    }
    return;
  }

  const { slot, ...spec } = layer;
  map.addSource(id, { type: 'geojson', data });
  map.addLayer({ id, source: id, ...spec, ...(slot ? { slot } : {}) } as mapboxgl.LayerSpecification);
}

export function applyOverlays(map: mapboxgl.Map, s: MapSettings, preset: LightPreset) {
  const kind = BASEMAPS[s.basemap].kind;
  const slot = kind === 'classic' ? undefined : 'top';
  const onDark = preset === 'night' || preset === 'dusk' || kind === 'standard-satellite';

  upsertGeoJson(map, TERMINATOR, s.terminator ? nightPolygon(new Date()) : null, {
    type: 'fill',
    slot,
    paint: { 'fill-color': 'hsl(230, 60%, 8%)', 'fill-opacity': onDark ? 0.35 : 0.22 },
  });

  upsertGeoJson(map, GRATICULE, s.graticule ? GRATICULE_DATA : null, {
    type: 'line',
    slot,
    paint: {
      'line-color': onDark ? 'rgba(255, 255, 255, 0.28)' : 'rgba(20, 40, 70, 0.25)',
      'line-width': ['match', ['get', 'kind'], 'equator', 1.4, 0.8],
    },
  });
}
