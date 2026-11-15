import { memo } from 'react';
import { fmtAgo, fmtKm2, fmtMw } from './format';
import { INCIDENT_FRP_STOPS, RAMP } from './layers';
import type { IncidentSummary } from './types';

interface Props {
  incidents: IncidentSummary[];
  selectedId: string | null;
  clock: number | null;
  onSelect(id: string): void;
  emptyText: string;
}

export function frpColor(mw: number): string {
  let i = 0;
  while (i < INCIDENT_FRP_STOPS.length - 1 && mw >= INCIDENT_FRP_STOPS[i + 1]) i++;
  return RAMP[i];
}

export function fmtLatLon([lon, lat]: [number, number]): string {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}

export const IncidentList = memo(function IncidentList({ incidents, selectedId, clock, onSelect, emptyText }: Props) {
  if (!incidents.length) return <p className="rt-empty">{emptyText}</p>;
  return (
    <ol className="rt-list" aria-label="Fire incidents, largest area with detections first">
      {incidents.map((i, n) => (
        <li key={i.id}>
          <button
            type="button"
            className={`rt-list__item ${i.id === selectedId ? 'is-selected' : ''} ${
              i.status === 'inactive' ? 'is-inactive' : ''
            }`}
            aria-current={i.id === selectedId}
            onClick={() => onSelect(i.id)}
          >
            <span className="rt-list__rank">{n + 1}</span>
            <span className="rt-list__main">
              <span className="rt-list__area">
                {fmtKm2(i.affectedAreaKm2)}
                {i.growthKm2PerDay > 0 && (
                  <span className="rt-list__growth">+{fmtKm2(i.growthKm2PerDay)}/day</span>
                )}
              </span>
              <span className="rt-list__meta">
                {fmtLatLon(i.centroid)}
                {i.status === 'inactive'
                  ? ' · inactive'
                  : clock !== null
                    ? ` · ${fmtAgo(i.lastSeen, clock)}`
                    : ''}
              </span>
            </span>
            <span className="rt-list__frp" title={`Peak fire radiative power (${i.frpMaxSensor ?? 'sensor unknown'})`}>
              <span className="rt-swatch" style={{ background: frpColor(i.frpMaxMw) }} aria-hidden="true" />
              {fmtMw(i.frpMaxMw)}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
});
