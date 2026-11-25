import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { getMeta, type ShowcasePeriod } from './lib/api';
import { showcaseFor } from './lib/useArchiveDetail';
import { DatePicker } from './components/DatePicker';
import { MapView } from './components/MapView';
import { TabSwitcher } from './components/TabSwitcher';
import { dateWindow, type Tab } from './lib/dataWindows';
import type { ISODate } from './lib/dates';
import { useMapSettings, type FireMode, type RangePreset } from './lib/mapSettings';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

/** The range a preset covers, ending on (or containing) the anchor day. Seasons are meteorological (DJF, MAM, JJA, SON). */
function presetRange(anchor: string, preset: RangePreset): { from: string; to: string; label: string } {
  const y = +anchor.slice(0, 4), m = +anchor.slice(5, 7) - 1, d = +anchor.slice(8, 10);
  switch (preset) {
    case 'day':
      return { from: anchor, to: anchor, label: `${d} ${MONTHS[m]} ${y}` };
    case 'week': {
      const f = utc(y, m, d - 6);
      return { from: iso(f), to: anchor, label: `${f.getUTCDate()} ${MONTHS[f.getUTCMonth()]} – ${d} ${MONTHS[m]} ${y}` };
    }
    case 'month':
      return { from: iso(utc(y, m, 1)), to: iso(utc(y, m + 1, 0)), label: `${MONTHS[m]} ${y}` };
    case 'season': {
      const start = Math.floor(((m + 1) % 12) / 3) * 3 - 1; // Dec=-1 (prev year), Mar=2, Jun=5, Sep=8
      const sy = m === 11 ? y + 1 : y; // December belongs to next year's winter
      const f = utc(sy, start, 1), t = utc(sy, start + 3, 0);
      const name = ['Winter (DJF)', 'Spring (MAM)', 'Summer (JJA)', 'Autumn (SON)'][Math.floor(((m + 1) % 12) / 3)];
      return { from: iso(f), to: iso(t), label: `${name} ${start < 0 ? `${sy - 1}–${String(sy).slice(2)}` : sy}` };
    }
    case 'year':
      return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) };
  }
}

/** Share links: #c=lon,lat,zoom&d=YYYY-MM-DD&p=preset&m=mode */
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const c = h.get('c')?.split(',').map(Number);
  return {
    view: c && c.length === 3 && c.every(Number.isFinite) ? { center: [c[0], c[1]] as [number, number], zoom: c[2] } : null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(h.get('d') ?? '') ? (h.get('d') as ISODate) : null,
    preset: (['day', 'week', 'month', 'season', 'year'] as const).find((p) => p === h.get('p')) ?? null,
    mode: (['activity', 'hotspots', 'raw'] as const).find((p) => p === h.get('m')) ?? null,
    tab: h.get('t') === 'archival' ? ('archival' as const) : null,
  };
}
import { ChatDrawer } from './chat/ChatDrawer';
import { buildContext } from './chat/context';
import { suggestionsFor } from './chat/suggestions';
import { RealtimeView, type RealtimeContext, type RealtimeRequest } from './realtime/RealtimeView';
import type { AppActions } from './help/actions';
import { HelpPanel } from './help/HelpPanel';
import { rememberWelcomeDismissed, welcomeDismissed } from './help/storage';
import { Welcome } from './help/Welcome';

export function App() {
  const initial = useMemo(readHash, []);
  const { settings, update, reset } = useMapSettings();
  useEffect(() => {
    const patch: Partial<typeof settings> = {};
    if (initial.preset) patch.rangePreset = initial.preset;
    if (initial.mode) patch.fireMode = initial.mode as FireMode;
    if (Object.keys(patch).length) update(patch);
  }, [initial, update]);

  const [archivalMax, setArchivalMax] = useState<ISODate | null>(null);
  // false: summary-only archive (no day-by-day hot spots); null while unknown.
  const [archivalDetail, setArchivalDetail] = useState<boolean | null>(null);
  const [showcase, setShowcase] = useState<ShowcasePeriod[]>([]);
  // Archival bounds come from the API (what is actually loaded), not from a hardcoded window.
  useEffect(() => {
    getMeta()
      .then((m) => {
        if (m.archival.maxDate) setArchivalMax(m.archival.maxDate as ISODate);
        setArchivalDetail(m.archival.detail !== false);
        setShowcase(m.archival.showcase ?? []);
      })
      .catch(() => {});
  }, []);
  const windows = useMemo(() => {
    const archival = dateWindow('archival');
    return { archival: archivalMax ? { ...archival, max: archivalMax < archival.max ? archivalMax : archival.max } : archival, realtime: dateWindow('realtime') };
  }, [archivalMax]);

  const [tab, setTab] = useState<Tab>(initial.tab ?? 'realtime');
  const [dates, setDates] = useState<Record<Tab, ISODate>>(() => ({
    archival: initial.date ?? ('2020-08-20' as ISODate), // California, Aug 2020: the first showcase period (see docs/issues/archival-showcase-data.md)
    realtime: windows.realtime.max,
  }));

  const range = windows[tab];
  const selected = dates[tab] > range.max ? range.max : dates[tab] < range.min ? range.min : dates[tab];
  const r = presetRange(selected, settings.rangePreset);
  const from = r.from < range.min ? range.min : r.from;
  const to = r.to > range.max ? range.max : r.to;
  const [map, setMap] = useState<mapboxgl.Map | null>(null);
  const [realtimeCtx, setRealtimeCtx] = useState<RealtimeContext | null>(null);
  // Realtime: the date never drives the map (Live is a rolling window, a replay is its scenario).
  const replayMode = tab === 'realtime' && realtimeCtx?.mode === 'replay';
  const inShowcase = tab === 'archival' && archivalDetail === false ? showcaseFor(showcase, from, to) : null;

  // UI actions for the welcome card and the copilot. Realtime requests are handled by RealtimeView once it mounts.
  const [rtRequest, setRtRequest] = useState<RealtimeRequest | null>(null);
  const [calendarRequest, setCalendarRequest] = useState(0);
  const requestId = useRef(0);
  const latest = useRef({ showcase, map });
  latest.current = { showcase, map };
  const showShowcase = useCallback((s: ShowcasePeriod) => {
    const mid = new Date((Date.parse(s.from) + Date.parse(s.to)) / 2).toISOString().slice(0, 10) as ISODate;
    update({ rangePreset: 'month' });
    setDates((prev) => ({ ...prev, archival: mid }));
    latest.current.map?.fitBounds([[s.bbox[0], s.bbox[1]], [s.bbox[2], s.bbox[3]]], { padding: 60, duration: 1200 });
  }, [update]);
  const actions = useMemo<AppActions>(() => ({
    showLive() {
      setTab('realtime');
      setRtRequest({ id: ++requestId.current, mode: 'live' });
    },
    showReplay(scenario) {
      setTab('realtime');
      setRtRequest({ id: ++requestId.current, mode: 'replay', scenario });
    },
    openShowcase(id) {
      setTab('archival');
      setCalendarRequest((n) => n + 1);
      const s = latest.current.showcase.find((x) => x.id === id);
      if (s) showShowcase(s);
      else if (id === 'california-2020-08') setDates((prev) => ({ ...prev, archival: '2020-08-20' as ISODate }));
    },
  }), [showShowcase]);
  const onRequestDone = useCallback((id: number) => setRtRequest((r) => (r?.id === id ? null : r)), []);

  // First visit: the welcome card, unless dismissed before or the page was opened from a share link.
  const [welcome, setWelcome] = useState(() => !welcomeDismissed() && !initial.view && !initial.tab);
  const closeWelcome = useCallback(() => { rememberWelcomeDismissed(); setWelcome(false); }, []);
  const [help, setHelp] = useState(false);
  const datePicker =
    tab === 'archival'
      ? {
          notice: inShowcase
            ? undefined
            : archivalDetail === false
              ? "Daily hot spots aren't loaded outside the showcase periods. Use the monthly calendar for history."
              : undefined,
        }
      : replayMode
        ? { label: 'June 2023', locked: 'This replay covers June 2023 only.' }
        : { label: 'Last 48 hours', locked: 'Live shows detections from the last 48 hours.' };

  return (
    <div className="app">
      <MapView
        tab={tab}
        from={from}
        to={to}
        rangeLabel={r.label}
        onPickDate={(d) => setDates((prev) => ({ ...prev, archival: d as ISODate }))}
        settings={settings}
        update={update}
        reset={reset}
        initialView={initial.view}
        onMapReady={setMap}
        calendarRequest={calendarRequest}
        shareUrl={(v) => `${location.origin}${location.pathname}#c=${v.center[0].toFixed(3)},${v.center[1].toFixed(3)},${v.zoom.toFixed(2)}&d=${selected}&p=${settings.rangePreset}&m=${settings.fireMode}&t=${tab}`}
      />
      {tab === 'realtime' && map && <RealtimeView map={map} onContextChange={setRealtimeCtx} request={rtRequest} onRequestDone={onRequestDone} />}
      <ChatDrawer
        getContext={() => buildContext({ map, tab, date: dates[tab], realtime: realtimeCtx })}
        suggestions={suggestionsFor(tab, realtimeCtx)}
      />

      <div className="overlay-top">
        <div className="overlay-top__start">
          <TabSwitcher value={tab} onChange={setTab} />
          <div className="brand material">
            <span className="brand__name">World Fires</span>
            <span className="brand__sub">Built at NASA Space Apps 2026</span>
          </div>
          <button type="button" className="help-button material" onClick={() => setHelp(true)} aria-label="Guide: what this site is and how to use it" aria-haspopup="dialog" title="Guide">
            ?
          </button>
        </div>
        {tab === 'archival' && archivalDetail === false && showcase.length > 0 && (
          <div className="showcase-picker material" role="group" aria-label="Showcase periods">
            <span className="showcase-picker__title">Showcase periods</span>
            {showcase.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`showcase-picker__btn ${inShowcase?.id === s.id ? 'is-active' : ''}`}
                aria-pressed={inShowcase?.id === s.id}
                onClick={() => showShowcase(s)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        <DatePicker
          key={tab}
          value={selected}
          min={range.min}
          max={range.max}
          onChange={(date) => setDates((prev) => ({ ...prev, [tab]: date }))}
          {...datePicker}
        />
            </div>
      {welcome && <Welcome actions={actions} onClose={closeWelcome} />}
      {help && <HelpPanel onClose={() => setHelp(false)} onShowWelcome={() => { setHelp(false); setWelcome(true); }} />}
    </div>
  );
}
