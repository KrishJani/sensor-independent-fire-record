import { useEffect, useMemo, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { getMeta } from './lib/api';
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
  };
}
import { ChatDrawer } from './chat/ChatDrawer';
import { buildContext } from './chat/context';
import { suggestionsFor } from './chat/suggestions';
import { RealtimeView, type RealtimeContext } from './realtime/RealtimeView';

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
  // Archival bounds come from the API (what is actually loaded), not from a hardcoded window.
  useEffect(() => {
    getMeta().then((m) => m.archival.maxDate && setArchivalMax(m.archival.maxDate as ISODate)).catch(() => {});
  }, []);
  const windows = useMemo(() => {
    const archival = dateWindow('archival');
    return { archival: archivalMax ? { ...archival, max: archivalMax < archival.max ? archivalMax : archival.max } : archival, realtime: dateWindow('realtime') };
  }, [archivalMax]);

  const [tab, setTab] = useState<Tab>('realtime');
  const [dates, setDates] = useState<Record<Tab, ISODate>>(() => ({
    archival: initial.date ?? ('2020-09-15' as ISODate), // a recent big fire year, so the map opens on something to see
    realtime: windows.realtime.max,
  }));

  const range = windows[tab];
  const selected = dates[tab] > range.max ? range.max : dates[tab] < range.min ? range.min : dates[tab];
  const r = presetRange(selected, settings.rangePreset);
  const from = r.from < range.min ? range.min : r.from;
  const to = r.to > range.max ? range.max : r.to;
  const [map, setMap] = useState<mapboxgl.Map | null>(null);
  const [realtimeCtx, setRealtimeCtx] = useState<RealtimeContext | null>(null);

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
        shareUrl={(v) => `${location.origin}${location.pathname}#c=${v.center[0].toFixed(3)},${v.center[1].toFixed(3)},${v.zoom.toFixed(2)}&d=${selected}&p=${settings.rangePreset}&m=${settings.fireMode}`}
      />
      {tab === 'realtime' && map && <RealtimeView map={map} onContextChange={setRealtimeCtx} />}
      <ChatDrawer
        getContext={() => buildContext({ map, tab, date: dates[tab], realtime: realtimeCtx })}
        suggestions={suggestionsFor(tab, realtimeCtx)}
      />

      <div className="overlay-top">
        <TabSwitcher value={tab} onChange={setTab} />
        <DatePicker
          key={tab}
          value={selected}
          min={range.min}
          max={range.max}
          onChange={(date) => setDates((prev) => ({ ...prev, [tab]: date }))}
        />
      </div>
    </div>
  );
}
