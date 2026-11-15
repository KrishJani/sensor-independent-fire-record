// Archival Fire Explorer panel (right side): time presets, fire display (harmonized by default), analysis
// overlays, notable events, and background. Harmonized modes are sensor-independent; raw detections are
// the only place sensors and FRP appear (provenance).
import { useEffect, useState, type ReactNode } from 'react';
import type mapboxgl from 'mapbox-gl';
import { api, type Bbox, type CalendarMonth } from '../lib/api';
import { BASEMAPS, BASEMAP_ORDER, type BasemapId } from '../lib/basemaps';
import { flameRamp, INDUSTRIAL_COLOR, PRONE_COLORS, SENSOR_COLORS } from '../lib/fireLayers';
import type { FireColoring, FireMode, MapSettings, RangePreset } from '../lib/mapSettings';
import { Segmented, type SegmentedOption } from './Segmented';
import { Toggle } from './Toggle';

const PRESETS: SegmentedOption<RangePreset>[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'season', label: 'Season' },
  { id: 'year', label: 'Year' },
];
const MODES: SegmentedOption<FireMode>[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'hotspots', label: 'Hotspots' },
  { id: 'raw', label: 'Raw' },
];
const MODE_NOTE: Record<FireMode, string> = {
  activity: 'Harmonized fire activity: VIIRS-equivalent cell-days per area. Comparable across all years and sensors.',
  hotspots: 'Each marker is a 5.5 km cell that burned in this period, counted the same way for every year and sensor.',
  raw: 'The satellites’ own detections. Sensor-dependent (VIIRS sees about 2× more); use for provenance.',
};
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Props {
  map: mapboxgl.Map;
  settings: MapSettings;
  onChange(patch: Partial<MapSettings>): void;
  rangeLabel: string;
  onJump(date: string, center?: [number, number], zoom?: number): void;
  open: boolean;
  onClose(): void;
}

export function FireExplorer({ map, settings: s, onChange, rangeLabel, onJump, open, onClose }: Props) {
  const coloringOptions: SegmentedOption<FireColoring>[] =
    s.fireMode === 'raw'
      ? [{ id: 'recency', label: 'Time' }, { id: 'intensity', label: 'Intensity' }, { id: 'sensor', label: 'Sensor' }]
      : [{ id: 'recency', label: 'Time' }, { id: 'amount', label: 'Amount' }];
  const coloring = coloringOptions.some((o) => o.id === s.fireColoring) ? s.fireColoring : 'recency';
  if (!open) return null;

  return (
    <aside className="explorer material" aria-label="Fire explorer">
      <header className="explorer__header">
        <h2>Fire Explorer</h2>
        <button type="button" className="text-button" onClick={onClose} aria-label="Close panel">✕</button>
      </header>

      <Section title="Time" meta={rangeLabel}>
        <Segmented<RangePreset> options={PRESETS} value={s.rangePreset} onChange={(rangePreset) => onChange({ rangePreset })} label="Time range" className="segmented--fill" />
        <p className="explorer__note">Pick the day in the date bar; the range ends on it.</p>
      </Section>

      <Section title="Fires & hotspots">
        <Toggle label="Show fire data" checked={s.fireActivity} onChange={(fireActivity) => onChange({ fireActivity })} />
        <Segmented<FireMode> options={MODES} value={s.fireMode} onChange={(fireMode) => onChange({ fireMode })} label="Display" className="segmented--fill" disabled={!s.fireActivity} />
        <p className="explorer__note">{MODE_NOTE[s.fireMode]}</p>
        <Segmented<FireColoring> options={coloringOptions} value={coloring} onChange={(fireColoring) => onChange({ fireColoring })} label="Colour by" className="segmented--fill" disabled={!s.fireActivity || s.fireMode === 'activity'} />
        {s.fireMode === 'raw' && (
          <div className="explorer__sensors">
            <Toggle label="VIIRS 375 m (2012 →)" checked={s.showViirs} onChange={(showViirs) => onChange({ showViirs })} />
            <span className="swatch" style={{ background: SENSOR_COLORS.VIIRS }} />
            <Toggle label="MODIS 1 km (2000 →)" checked={s.showModis} onChange={(showModis) => onChange({ showModis })} />
            <span className="swatch" style={{ background: SENSOR_COLORS.MODIS }} />
          </div>
        )}
        <Legend mode={s.fireMode} coloring={coloring} />
      </Section>

      <Section title="Analysis overlays">
        <Toggle label="Fire-prone areas (US, 2001–2025)" checked={s.proneAreas} onChange={(proneAreas) => onChange({ proneAreas })} />
        {s.proneAreas && (
          <div className="explorer__legend">
            {(['very_high', 'high', 'elevated'] as const).map((k) => (
              <span key={k}><i style={{ background: PRONE_COLORS[k] }} />{k.replace('_', ' ')}</span>
            ))}
          </div>
        )}
        <Toggle label="Industrial heat (flares, static sources)" checked={s.industrialHeat} onChange={(industrialHeat) => onChange({ industrialHeat })} />
        {s.industrialHeat && <p className="explorer__note"><i className="swatch" style={{ background: INDUSTRIAL_COLOR }} /> Not counted as fire. Visible from regional zoom.</p>}
        <Toggle label="Harmonized region outlines" checked={s.regionOutlines} onChange={(regionOutlines) => onChange({ regionOutlines })} />
      </Section>

      <NotableEvents map={map} onJump={onJump} />

      <Section title="Background">
        <Segmented<BasemapId> options={BASEMAP_ORDER.map((id) => ({ id, label: BASEMAPS[id].label }))} value={s.basemap} onChange={(basemap) => onChange({ basemap })} label="Map type" className="segmented--fill" />
      </Section>
    </aside>
  );
}

function Legend({ mode, coloring }: { mode: FireMode; coloring: FireColoring }) {
  if (coloring === 'sensor') return null;
  const [lo, hi] = mode === 'activity' || coloring === 'amount' ? ['less', 'more cell-days'] : coloring === 'intensity' ? ['low FRP', 'high FRP'] : ['oldest', 'newest'];
  const ramp = flameRamp(); // low → high; for time, oldest → newest
  return (
    <div className="explorer__ramp">
      <span>{lo}</span>
      {ramp.map((c) => <i key={c} style={{ background: c }} />)}
      <span>{hi}</span>
    </div>
  );
}

/** Notable events (archival): record months in view and the most significant fire-prone areas. */
function NotableEvents({ map, onJump }: { map: mapboxgl.Map; onJump(date: string, center?: [number, number], zoom?: number): void }) {
  const [months, setMonths] = useState<CalendarMonth[] | null>(null);
  const [prone, setProne] = useState<{ lat: number; lon: number; region_id: string; why: string }[] | null>(null);
  const [scopeLabel, setScopeLabel] = useState('the United States');

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const ac = { current: null as AbortController | null };
    const load = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const b = map.getBounds()!;
        const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => Math.round(v * 20) / 20) as Bbox;
        const small = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) <= 400;
        ac.current?.abort();
        const c = (ac.current = new AbortController());
        setScopeLabel(small ? 'this view' : 'the United States');
        api.calendar(small ? { bbox } : { scope: 'us' }, c.signal)
          .then((d) => setMonths(d.calendar.filter((m) => m.complete && m.anomaly && (m.anomaly.class === 'record_high' || m.anomaly.class === 'much_above'))
            .sort((a, b) => (b.anomaly!.ratioToMedian ?? 0) - (a.anomaly!.ratioToMedian ?? 0)).slice(0, 5)))
          .catch(() => setMonths([]));
      }, 1000);
    };
    load();
    map.on('moveend', load);
    api.proneSummary().then((p) => setProne(p.mostSignificant.slice(0, 4))).catch(() => setProne([]));
    return () => { clearTimeout(t); map.off('moveend', load); ac.current?.abort(); };
  }, [map]);

  return (
    <Section title="Notable events" meta={scopeLabel}>
      {months === null && <p className="explorer__note">Loading…</p>}
      {months?.length === 0 && <p className="explorer__note">No months far above normal here.</p>}
      <ul className="explorer__events">
        {months?.map((m) => (
          <li key={`${m.year}-${m.month}`}>
            <button type="button" onClick={() => onJump(`${m.year}-${String(m.month).padStart(2, '0')}-15`)}>
              <span className={`badge badge--${m.anomaly!.class}`}>{m.anomaly!.class === 'record_high' ? 'Record' : 'Far above'}</span>
              <b>{MONTH_NAMES[m.month - 1]} {m.year}</b>
              <span>{m.anomaly!.ratioToMedian}× the usual {MONTH_NAMES[m.month - 1]}</span>
            </button>
          </li>
        ))}
      </ul>
      {prone && prone.length > 0 && (
        <>
          <p className="explorer__subhead">Most significant fire-prone areas</p>
          <ul className="explorer__events">
            {prone.map((p) => (
              <li key={`${p.lat},${p.lon}`}>
                <button type="button" onClick={() => onJump('', [p.lon, p.lat], 8)}>
                  <span className="badge badge--prone">Prone</span>
                  <b>{p.lat.toFixed(2)}°, {p.lon.toFixed(2)}°</b>
                  <span>{p.why}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section className="explorer__section">
      <h3>{title}{meta && <span className="explorer__meta">{meta}</span>}</h3>
      {children}
    </section>
  );
}
