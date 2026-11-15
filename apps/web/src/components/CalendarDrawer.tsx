import { DIVERGING, divergingColor, YLORRD } from '../lib/colors';
import { Ember } from './Ember';
// Archival burning-activity calendar (SPEC.md §7.1): Year × Month heatmap for the US or the current view,
// with the before/after-harmonization toggle, 90% bands and anomalies on hover, and CSV export.
import { useEffect, useMemo, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { api, isOutsideCoverage, OUTSIDE_COVERAGE_TEXT, type Bbox, type CalendarMonth, type CalendarResponse } from '../lib/api';
import { Segmented, type SegmentedOption } from './Segmented';

type Series = 'harmonized' | 'gridded' | 'raw';
type Scope = 'us' | 'view' | 'drawn' | 'region';
type Measure = 'actual' | 'anomaly';
const MEASURES: SegmentedOption<Measure>[] = [
  { id: 'actual', label: 'Actual' },
  { id: 'anomaly', label: 'vs normal' },
];
const SERIES: SegmentedOption<Series>[] = [
  { id: 'raw', label: 'Raw' },
  { id: 'gridded', label: 'Gridded' },
  { id: 'harmonized', label: 'Harmonized' },
];
const SCOPES: SegmentedOption<Scope>[] = [
  { id: 'us', label: 'United States' },
  { id: 'view', label: 'This view' },
];
const DRAWN: SegmentedOption<Scope> = { id: 'drawn', label: 'Drawn area' };
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RAMP = YLORRD;
const value = (m: CalendarMonth, s: Series) => (s === 'harmonized' ? m.harmonizedCellDays : s === 'gridded' ? m.unscaledCellDays : m.rawDetections);
const fmt = (n: number) => Math.round(n).toLocaleString();

interface Props {
  map: mapboxgl.Map;
  onPickMonth(date: string): void;
  onClose(): void;
  /** Region the user clicked on the map; shown as its own area option. */
  region?: { bbox: Bbox; name: string } | null;
  /** Polygon from the Measure tool's "Analyse this area"; switches the calendar to that shape. */
  drawn?: GeoJSON.Polygon | null;
}

export function CalendarDrawer({ map, onPickMonth, onClose, drawn, region }: Props) {
  const open = true;
  const [series, setSeries] = useState<Series>('harmonized');
  const [measure, setMeasure] = useState<Measure>('actual');
  const [scope, setScope] = useState<Scope>(() => (drawn ? 'drawn' : region ? 'region' : 'us'));
  // Display-only year filter: the request (and its anomaly baseline) always covers every year.
  const [yearRange, setYearRange] = useState<[number, number] | null>(null);
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outside, setOutside] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<CalendarMonth | null>(null);
  const [viewBox, setViewBox] = useState<Bbox | null>(null);

  useEffect(() => { if (drawn) setScope('drawn'); else setScope((s) => (s === 'drawn' ? 'us' : s)); }, [drawn]);
  useEffect(() => { if (region) setScope('region'); }, [region]);
  useEffect(() => setYearRange(null), [scope, region, drawn]);

  // "This view": follow the map, debounced (SPEC §7.2 step 9).
  useEffect(() => {
    if (scope !== 'view') return;
    let t: ReturnType<typeof setTimeout>;
    const update = () => { clearTimeout(t); t = setTimeout(() => { const b = map.getBounds()!; setViewBox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => Math.round(v * 20) / 20) as Bbox); }, 1000); };
    update();
    map.on('moveend', update);
    return () => { clearTimeout(t); map.off('moveend', update); };
  }, [map, scope]);

  useEffect(() => {
    if (!open) return;
    if (scope === 'view' && !viewBox) return;
    if (scope === 'drawn' && !drawn) return;
    if (scope === 'region' && !region) return;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    setOutside(false);
    api.calendar(scope === 'us' ? { scope: 'us' } : scope === 'drawn' ? { geometry: drawn! } : scope === 'region' ? { bbox: region!.bbox } : { bbox: viewBox! }, ac.signal)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        // Outside harmonized coverage: a note, never a (zero) grid.
        if (isOutsideCoverage(e)) { setData(null); setOutside(true); setError(OUTSIDE_COVERAGE_TEXT); } else setError(e.message);
        setLoading(false);
      });
    return () => ac.abort();
  }, [open, scope, viewBox, drawn, region]);

  const grid = useMemo(() => {
    if (!data) return null;
    const allYears = [...new Set(data.calendar.map((m) => m.year))].sort((a, b) => a - b);
    const years = yearRange ? allYears.filter((y) => y >= yearRange[0] && y <= yearRange[1]) : allYears;
    const byKey = new Map(data.calendar.map((m) => [`${m.year}-${m.month}`, m]));
    const vals = data.calendar.filter((m) => m.complete).map((m) => value(m, series)).filter((v) => v > 0).sort((a, b) => a - b);
    const bks = RAMP.slice(1).map((_, i) => vals[Math.floor(((i + 1) / RAMP.length) * (vals.length - 1))] ?? 0);
    // Colour scale over every year, so narrowing the displayed range never rescales the colours.
    const actual = (v: number) => (v <= 0 ? 'var(--track)' : RAMP[bks.filter((b) => v > b).length]);
    const color = (m: CalendarMonth) =>
      measure === 'anomaly'
        ? m.anomaly?.ratioToMedian != null ? divergingColor(m.anomaly.ratioToMedian) : 'var(--track)'
        : actual(value(m, series));
    return { years, allYears, byKey, color, min: vals[0] ?? 0, max: vals.at(-1) ?? 0 };
  }, [data, series, measure, yearRange]);
  const areaOptions = [...SCOPES, ...(region ? [{ id: 'region' as const, label: region.name }] : []), ...(drawn ? [DRAWN] : [])];

  return (
    <section className={`calendar-drawer material${open ? '' : ' calendar-drawer--closed'}`} aria-label="Burning activity calendar">
      <header className="calendar-drawer__header">
        <span className="calendar-drawer__title">Burning activity calendar</span>
        {open && (
          <div className="calendar-drawer__controls">
            <Segmented<Scope> options={areaOptions} value={scope} onChange={setScope} label="Area" />
            <Segmented<Measure> options={MEASURES} value={measure} onChange={setMeasure} label="Measure" />
            {measure === 'actual' && <Segmented<Series> options={SERIES} value={series} onChange={setSeries} label="Series" />}
            {grid && grid.allYears.length > 1 && (
              <span className="calendar-years" aria-label="Years shown">
                <select value={yearRange?.[0] ?? grid.allYears[0]} onChange={(e) => setYearRange([+e.target.value, yearRange?.[1] ?? grid.allYears.at(-1)!])} aria-label="From year">
                  {grid.allYears.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
                –
                <select value={yearRange?.[1] ?? grid.allYears.at(-1)} onChange={(e) => setYearRange([yearRange?.[0] ?? grid.allYears[0], +e.target.value])} aria-label="To year">
                  {grid.allYears.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </span>
            )}
            {data && scope !== 'drawn' && (
              <a className="text-button" href={api.calendarCsvUrl(scope === 'us' ? { scope: 'us' } : { bbox: viewBox! })}>
                CSV
              </a>
            )}
            <button type="button" className="calendar-drawer__close" onClick={onClose} aria-label="Close calendar">×</button>
          </div>
        )}
      </header>
      {open && (
        <div className="calendar-drawer__body">
          {loading && <p className="calendar-drawer__note"><Ember caption="Loading" /></p>}
          {error && <p className={`calendar-drawer__note${outside ? ' calendar-drawer__note--outside' : ' calendar-drawer__note--error'}`}>{error}</p>}
          {!error && data?.meta && data.meta.coverage < 0.995 && (
            <p className="calendar-drawer__note">Partial coverage: {Math.round(data.meta.coverage * 100)}% of this area is in the harmonized US regions.</p>
          )}
          {grid && data && !error && (
            <>
              <div className="calendar-grid" role="grid" onMouseLeave={() => setHover(null)}>
                <div />
                {MONTHS.map((m, i) => <div key={i} className="calendar-grid__label">{m}</div>)}
                {grid.years.map((y) => (
                  <Row key={y} year={y} grid={grid} series={series} onHover={setHover} onPick={onPickMonth} />
                ))}
              </div>
              <aside className="calendar-drawer__side">
                {hover ? (
                  <dl className="calendar-tip">
                    <dt>{MONTH_NAMES[hover.month - 1]} {hover.year}{hover.complete ? '' : ' (partial)'}</dt>
                    <dd><b>{fmt(hover.harmonizedCellDays)}</b> harmonized cell-days{hover.hi - hover.lo > 1 ? ` (90%: ${fmt(hover.lo)}–${fmt(hover.hi)})` : ''}</dd>
                    <dd>{fmt(hover.unscaledCellDays)} gridded · {fmt(hover.rawDetections)} raw detections</dd>
                    <dd>{hover.sourceMix >= 0.999 ? 'VIIRS (observed)' : hover.sourceMix <= 0.001 ? 'MODIS × α (harmonized)' : `${Math.round(hover.sourceMix * 100)}% VIIRS days`}</dd>
                    {hover.anomaly && <dd>{hover.anomaly.class.replace('_', ' ')} · {hover.anomaly.ratioToMedian ?? '—'}× median</dd>}
                    {hover.peakFrpMw && <dd>peak FRP {fmt(hover.peakFrpMw)} MW ({hover.peakFrpSensor})</dd>}
                  </dl>
                ) : (
                  <dl className="calendar-tip">
                    <dt>Summary</dt>
                    {data.summary.peakMonth && <dd>Peak month: <b>{data.summary.peakMonth}</b></dd>}
                    {data.summary.peakYear && <dd>Peak year: <b>{data.summary.peakYear}</b></dd>}
                    {data.summary.criticalMonthNames.length > 0 && <dd>Critical months: {data.summary.criticalMonthNames.join(', ')}</dd>}
                    <dd className="calendar-drawer__note">Hover a month for details; click it to show that month on the map.</dd>
                  </dl>
                )}
                {measure === 'anomaly' ? (
                  <div className="calendar-legend" aria-hidden>
                    <span>less than normal</span>
                    {DIVERGING.map((d) => <i key={d.color} style={{ background: d.color }} title={d.label} />)}
                    <span>more than normal</span>
                  </div>
                ) : (
                  <div className="calendar-legend" aria-hidden>
                    <span>{fmt(grid.min)}</span>
                    {RAMP.map((c) => <i key={c} style={{ background: c }} />)}
                    <span>{fmt(grid.max)}</span>
                  </div>
                )}
                <p className="calendar-drawer__note">{measure === 'anomaly' ? 'Each month against its own median over the full record (harmonized).' : series === 'raw' ? 'Raw dots jump when VIIRS starts (2012).' : series === 'gridded' ? 'Gridded to 5.5 km cells, no α.' : 'VIIRS-equivalent; MODIS-only years scaled with α.'}</p>
              </aside>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Row({ year, grid, series, onHover, onPick }: { year: number; grid: { byKey: Map<string, CalendarMonth>; color(m: CalendarMonth): string }; series: Series; onHover(m: CalendarMonth): void; onPick(d: string): void }) {
  return (
    <>
      <div className={`calendar-grid__label${year === 2012 ? ' calendar-grid__label--viirs' : ''}`}>{year}</div>
      {Array.from({ length: 12 }, (_, i) => {
        const m = grid.byKey.get(`${year}-${i + 1}`);
        if (!m) return <div key={i} />;
        return (
          <button
            key={i}
            type="button"
            className={`calendar-grid__cell${m.complete ? '' : ' calendar-grid__cell--partial'}`}
            style={{ background: grid.color(m) }}
            aria-label={`${MONTH_NAMES[i]} ${year}: ${fmt(value(m, series))}`}
            onMouseEnter={() => onHover(m)}
            onFocus={() => onHover(m)}
            onClick={() => onPick(`${year}-${String(i + 1).padStart(2, '0')}-15`)}
          />
        );
      })}
    </>
  );
}
