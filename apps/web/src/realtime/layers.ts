import { FADE_IN_MS } from './config';
import { YLORRD5 } from '../lib/colors';
import type mapboxgl from 'mapbox-gl';
import type { Feature, FeatureCollection, Point } from 'geojson';
import type { DetectionPoint, IncidentSummary } from './types';

/**
 * Ids start with `overlay-` so lib/basemaps.ts `applyClassicDetails` does not hide our labels
 * when place labels are switched off on classic basemaps.
 */
export const SRC = {
  detections: 'overlay-rt-detections',
  incidents: 'overlay-rt-incidents',
  annotations: 'overlay-rt-annotations',
} as const;

export const LAYER = {
  points: 'overlay-rt-points',
  incidentSelected: 'overlay-rt-incident-selected',
  incidentCasing: 'overlay-rt-incident-casing',
  incidents: 'overlay-rt-incident',
  incidentLabels: 'overlay-rt-incident-label',
  annotationDot: 'overlay-rt-annotation-dot',
  annotationLabel: 'overlay-rt-annotation-label',
} as const;

/** Layers that respond to clicks, top first. */
export const INCIDENT_HIT_LAYERS = [LAYER.incidents];

/** The shared YlOrRd ramp (lib/colors.ts), low → high. */
export const RAMP = YLORRD5;

/** Detection FRP stops (MW) for the ramp. */
export const POINT_FRP_STOPS = [1, 10, 40, 150, 500] as const;
/** Incident max-FRP stops (MW). */
export const INCIDENT_FRP_STOPS = [50, 200, 600, 1500, 4000] as const;

function ramp(prop: string, stops: readonly number[]): mapboxgl.ExpressionSpecification {
  const expr: unknown[] = ['interpolate', ['linear'], ['get', prop]];
  stops.forEach((s, i) => expr.push(s, RAMP[i]));
  return expr as mapboxgl.ExpressionSpecification;
}

/** Pixels per km at zoom z for 512 px tiles, at the equator. */
const pxPerKm = (z: number) => (512 * 2 ** z) / 40075.017;

/** Circle radius that matches `rkm` on the ground (rkm already divided by cos(lat)). */
function groundRadius(minPx: number): mapboxgl.ExpressionSpecification {
  const expr: unknown[] = ['interpolate', ['exponential', 2], ['zoom']];
  for (const z of [0, 3, 6, 9, 12, 15]) expr.push(z, ['max', minPx, ['*', ['get', 'rkm'], pxPerKm(z)]]);
  return expr as mapboxgl.ExpressionSpecification;
}

/** Subtle fade with age in stream hours (`a`): fresh points solid, 48 h old ones still visible. */
const AGE_OPACITY: mapboxgl.ExpressionSpecification = [
  '*',
  ['coalesce', ['get', 'f'], 1],
  ['interpolate', ['linear'], ['get', 'a'], 0, 1, 24, 0.8, 48, 0.6],
];
/** Detection age (hours), FIRMS-like: newest bright red, older a slightly deeper red. */
export const AGE_STOPS = [
  [0, '#ff3b2b'], [12, '#e8261f'], [24, '#c81b1c'], [48, '#a3141a'],
] as const;
const AGE_COLOR = ['interpolate', ['linear'], ['get', 'a'], ...AGE_STOPS.flat()] as unknown as mapboxgl.ExpressionSpecification;
/** Radius grows from 40% to full while a detection fades in. */
const GROW: mapboxgl.ExpressionSpecification = ['+', 0.4, ['*', 0.6, ['coalesce', ['get', 'f'], 1]]];

export function layerSpecs(): mapboxgl.LayerSpecification[] {
  return [
    {
      // FIRMS-style hotspot: small crisp red dot at every zoom, a little larger as you zoom in.
      id: LAYER.points,
      type: 'circle',
      source: SRC.detections,
      paint: {
        'circle-radius': [
          'interpolate', ['exponential', 1.5], ['zoom'],
          1, ['*', GROW, 1.3],
          5, ['*', GROW, 2.2],
          9, ['*', GROW, 3.6],
          13, ['*', GROW, 6],
        ],
        'circle-color': AGE_COLOR,
        'circle-opacity': AGE_OPACITY,
        'circle-stroke-width': 0,
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: LAYER.incidentSelected,
      type: 'circle',
      source: SRC.incidents,
      filter: ['==', ['get', 'selected'], true],
      paint: {
        'circle-radius': groundRadius(6),
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 4,
        'circle-stroke-opacity': 0.95,
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: LAYER.incidentCasing,
      type: 'circle',
      source: SRC.incidents,
      paint: {
        'circle-radius': groundRadius(6),
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': 'rgba(10,10,12,0.6)',
        'circle-stroke-width': 3,
        'circle-stroke-opacity': ['match', ['get', 'status'], 'inactive', 0.35, 1],
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: LAYER.incidents,
      type: 'circle',
      source: SRC.incidents,
      paint: {
        'circle-radius': groundRadius(6),
        'circle-color': ramp('frp', INCIDENT_FRP_STOPS),
        // Outline ring with a barely-there fill, so the red detection dots inside stay visible.
        'circle-opacity': ['match', ['get', 'status'], 'inactive', 0.02, 0.05],
        'circle-stroke-color': ramp('frp', INCIDENT_FRP_STOPS),
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': ['match', ['get', 'status'], 'inactive', 0.4, 1],
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: LAYER.incidentLabels,
      type: 'symbol',
      source: SRC.incidents,
      filter: ['any', ['==', ['get', 'selected'], true], ['<=', ['get', 'rank'], 6]],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11, 9, 13],
        'text-anchor': 'top',
        'text-offset': [0, 0.9],
        'text-allow-overlap': false,
        'text-optional': true,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': 'rgba(0,0,0,0.75)',
        'text-halo-width': 1.1,
        'text-halo-blur': 0.4,
      },
    },
    {
      id: LAYER.annotationDot,
      type: 'circle',
      source: SRC.annotations,
      paint: {
        'circle-radius': 4.5,
        'circle-color': '#ffffff',
        'circle-stroke-color': 'rgba(0,0,0,0.85)',
        'circle-stroke-width': 2,
      },
    },
    {
      id: LAYER.annotationLabel,
      type: 'symbol',
      source: SRC.annotations,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
        'text-size': 12,
        // Above-right of the dot: the basemap's own "New York" label sits to the lower right.
        'text-anchor': 'bottom-left',
        'text-offset': [0.5, -0.5],
        'text-max-width': 30,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': 'rgba(0,0,0,0.75)',
        'text-halo-width': 1.1,
        'text-halo-blur': 0.4,
      },
    },
  ] as mapboxgl.LayerSpecification[];
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Adds any missing realtime sources/layers. Safe to call repeatedly (e.g. after every style.load). */
export function ensureRealtimeLayers(map: mapboxgl.Map) {
  // Standard styles expose slots; classic ones do not (same rule as lib/overlays.ts).
  const slot = map.getSlots?.().includes('top') ? 'top' : undefined;
  for (const id of Object.values(SRC)) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
  }
  for (const spec of layerSpecs()) {
    if (!map.getLayer(spec.id)) map.addLayer({ ...spec, ...(slot ? { slot } : {}) });
  }
}

export function removeRealtimeLayers(map: mapboxgl.Map) {
  for (const spec of layerSpecs().reverse()) if (map.getLayer(spec.id)) map.removeLayer(spec.id);
  for (const id of Object.values(SRC)) if (map.getSource(id)) map.removeSource(id);
}

export function detectionsGeoJson(
  points: DetectionPoint[],
  now: number | null,
  arrived?: number[],
  realNow = performance.now(),
): FeatureCollection<Point> {
  const ref = now ?? (points.length ? points[points.length - 1][3] : 0);
  return {
    type: 'FeatureCollection',
    features: points.map(
      ([lon, lat, frp, t, conf], i): Feature<Point> => ({
        type: 'Feature',
        // f: fade-in 0..1 since the point arrived (real time), so new detections ease in instead of popping.
        properties: { frp, a: Math.max(0, (ref - t) / 3600_000), conf, f: arrived ? Math.min(1, Math.max(0, (realNow - arrived[i]) / FADE_IN_MS)) : 1 },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      }),
    ),
  };
}

/** Visible incidents (merged ones hidden), ranked by affected area. */
export function visibleIncidents(incidents: Iterable<IncidentSummary>): IncidentSummary[] {
  return [...incidents]
    .filter((i) => i.status !== 'merged' && i.significant !== false)
    .sort((a, b) => b.affectedAreaKm2 - a.affectedAreaKm2);
}

const areaLabel = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export function incidentsGeoJson(
  ranked: IncidentSummary[],
  selectedId: string | null,
): FeatureCollection<Point> {
  let activeRank = 0;
  return {
    type: 'FeatureCollection',
    features: ranked.map((i): Feature<Point> => {
      const rank = i.status === 'active' ? ++activeRank : 999;
      const [lon, lat] = i.centroid;
      // Equal-area circle, widened by 1/cos(lat) to undo Web Mercator's scale at this latitude.
      const rkm = Math.sqrt(i.affectedAreaKm2 / Math.PI) / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
      const peak = i.frpMaxMw >= 1000 ? `${(i.frpMaxMw / 1000).toFixed(1)} GW` : `${Math.round(i.frpMaxMw)} MW`;
      return {
        type: 'Feature',
        id: i.id,
        properties: {
          id: i.id,
          rkm,
          frp: i.frpMaxMw,
          status: i.status,
          rank,
          selected: i.id === selectedId,
          label: `${areaLabel.format(i.affectedAreaKm2)} km² · peak ${peak}`,
        },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      };
    }),
  };
}

export interface Annotation {
  lon: number;
  lat: number;
  label: string;
}

export function annotationsGeoJson(items: Annotation[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: items.map((a) => ({
      type: 'Feature',
      properties: { label: a.label },
      geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
    })),
  };
}
