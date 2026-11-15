import { useEffect, useState } from 'react';
import type mapboxgl from 'mapbox-gl';

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const MAX_SCALE_PX = 96;

interface Props {
  map: mapboxgl.Map;
  showCoordinates: boolean;
  showScale: boolean;
}

interface Readout {
  cursor: { lat: number; lng: number } | null;
  scale: { px: number; label: string };
}

function formatCoord(value: number, pos: string, neg: string): string {
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? pos : neg}`;
}

function niceDistance(meters: number): number {
  const pow = 10 ** Math.floor(Math.log10(meters));
  const d = meters / pow;
  return (d >= 5 ? 5 : d >= 2 ? 2 : 1) * pow;
}

function scaleFor(map: mapboxgl.Map): Readout['scale'] {
  const { lat } = map.getCenter();
  const metersPerPx =
    (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
  const meters = niceDistance(metersPerPx * MAX_SCALE_PX);
  const label = meters >= 1000 ? `${(meters / 1000).toLocaleString()} km` : `${meters} m`;
  return { px: Math.round(meters / metersPerPx), label };
}

export function StatusBar({ map, showCoordinates, showScale }: Props) {
  const [readout, setReadout] = useState<Readout>(() => ({ cursor: null, scale: scaleFor(map) }));

  useEffect(() => {
    let frame = 0;
    let cursor: Readout['cursor'] = null;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setReadout({ cursor, scale: scaleFor(map) }));
    };
    const onMove = (e: mapboxgl.MapMouseEvent) => {
      cursor = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      schedule();
    };
    const onLeave = () => {
      cursor = null;
      schedule();
    };

    map.on('mousemove', onMove);
    map.on('mouseout', onLeave);
    map.on('move', schedule);
    return () => {
      cancelAnimationFrame(frame);
      map.off('mousemove', onMove);
      map.off('mouseout', onLeave);
      map.off('move', schedule);
    };
  }, [map]);

  if (!showCoordinates && !showScale) return null;

  const coords = readout.cursor ?? map.getCenter();

  return (
    <div className="status-bar material">
      {showScale && (
        <span className="status-bar__scale">
          <span className="status-bar__scale-bar" style={{ width: readout.scale.px }} />
          {readout.scale.label}
        </span>
      )}
      {showScale && showCoordinates && <span className="divider divider--vertical" />}
      {showCoordinates && (
        <span className="status-bar__coords">
          {formatCoord(coords.lat, 'N', 'S')}, {formatCoord(coords.lng, 'E', 'W')}
        </span>
      )}
    </div>
  );
}
