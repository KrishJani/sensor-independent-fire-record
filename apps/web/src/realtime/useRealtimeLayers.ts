import { useEffect, useRef } from 'react';
import type mapboxgl from 'mapbox-gl';
import type { FeatureCollection } from 'geojson';
import { FADE_IN_MS, MAP_UPDATE_MS } from './config';
import {
  annotationsGeoJson,
  detectionsGeoJson,
  ensureRealtimeLayers,
  INCIDENT_HIT_LAYERS,
  incidentsGeoJson,
  removeRealtimeLayers,
  SRC,
  type Annotation,
} from './layers';
import type { IncidentSummary } from './types';
import type { PointBuffer, StreamClock } from './useRealtimeStream';

interface Options {
  points: PointBuffer;
  /** Interpolated per push, so ages and fades move continuously between server ticks. */
  streamClock: StreamClock;
  /** Already filtered (no merged) and sorted by area, largest first. */
  incidents: IncidentSummary[];
  selectedId: string | null;
  annotations: Annotation[];
  onSelect(id: string | null): void;
}

/**
 * Draws the realtime stream on the map. Data is pushed on a fixed tick (about 2/s) and
 * only when something changed. The layers are re-added after every `style.load`,
 * because switching basemaps (map.setStyle) drops custom sources and layers.
 */
export function useRealtimeLayers(map: mapboxgl.Map | null, opts: Options) {
  const latest = useRef(opts);
  latest.current = opts;
  // Bumped whenever incident/annotation data changes; the tick compares it with what was pushed.
  const incidentsVersion = useRef(0);

  useEffect(() => {
    incidentsVersion.current++;
  }, [opts.incidents, opts.selectedId, opts.annotations]);

  useEffect(() => {
    if (!map) return;
    const pushed = { points: -1, clock: null as number | null, incidents: -1, lastArrival: 0 };

    const setData = (id: string, data: FeatureCollection) =>
      (map.getSource(id) as mapboxgl.GeoJSONSource | undefined)?.setData(data);

    const push = (force = false) => {
      const o = latest.current;
      if (!map.getSource(SRC.detections)) return;
      // Ages are relative to stream time, so a moving clock also refreshes the detections;
      // so does a fade-in still in progress.
      const now = performance.now();
      const clock = o.streamClock.clockAt(now);
      const fading = now - pushed.lastArrival < FADE_IN_MS + MAP_UPDATE_MS;
      if (force || fading || o.points.version !== pushed.points || clock !== pushed.clock) {
        const arr = o.points.arrived;
        setData(SRC.detections, detectionsGeoJson(o.points.points, clock, arr, now));
        pushed.points = o.points.version;
        pushed.clock = clock;
        pushed.lastArrival = arr.length ? arr[arr.length - 1] : 0;
      }
      if (force || incidentsVersion.current !== pushed.incidents) {
        setData(SRC.incidents, incidentsGeoJson(o.incidents, o.selectedId));
        setData(SRC.annotations, annotationsGeoJson(o.annotations));
        pushed.incidents = incidentsVersion.current;
      }
    };

    const install = () => {
      try {
        ensureRealtimeLayers(map);
        push(true);
      } catch {
        /* style still loading: style.load will call us again */
      }
    };

    install();
    map.on('style.load', install);
    const tick = setInterval(() => push(), MAP_UPDATE_MS);

    const hitLayers = () => INCIDENT_HIT_LAYERS.filter((id) => map.getLayer(id));
    const onClick = (e: mapboxgl.MapMouseEvent) => {
      const layers = hitLayers();
      if (!layers.length) return;
      // Smallest circle first, so a small fire inside a big one stays clickable.
      const hits = map.queryRenderedFeatures(e.point, { layers });
      if (!hits.length) return;
      hits.sort((a, b) => Number(a.properties?.rkm ?? 0) - Number(b.properties?.rkm ?? 0));
      latest.current.onSelect(String(hits[0].properties?.id));
    };
    const onMove = (e: mapboxgl.MapMouseEvent) => {
      const layers = hitLayers();
      const over = layers.length > 0 && map.queryRenderedFeatures(e.point, { layers }).length > 0;
      map.getCanvas().style.cursor = over ? 'pointer' : '';
    };
    map.on('click', onClick);
    map.on('mousemove', onMove);

    return () => {
      clearInterval(tick);
      map.off('style.load', install);
      map.off('click', onClick);
      map.off('mousemove', onMove);
      map.getCanvas().style.cursor = '';
      try {
        removeRealtimeLayers(map);
      } catch {
        /* map already removed */
      }
    };
  }, [map]);
}
