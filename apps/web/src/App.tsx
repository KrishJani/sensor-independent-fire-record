import { useMemo, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { DatePicker } from './components/DatePicker';
import { MapView } from './components/MapView';
import { TabSwitcher } from './components/TabSwitcher';
import { dateWindow, type Tab } from './lib/dataWindows';
import type { ISODate } from './lib/dates';
import { ChatDrawer } from './chat/ChatDrawer';
import { buildContext } from './chat/context';
import { suggestionsFor } from './chat/suggestions';
import { RealtimeView, type RealtimeContext } from './realtime/RealtimeView';

export function App() {
  const windows = useMemo(
    () => ({ archival: dateWindow('archival'), realtime: dateWindow('realtime') }),
    [],
  );
  const [tab, setTab] = useState<Tab>('archival');
  const [dates, setDates] = useState<Record<Tab, ISODate>>(() => ({
    archival: windows.archival.max,
    realtime: windows.realtime.max,
  }));

  const range = windows[tab];
  const [map, setMap] = useState<mapboxgl.Map | null>(null);
  const [realtimeCtx, setRealtimeCtx] = useState<RealtimeContext | null>(null);

  return (
    <div className="app">
      <MapView onMapReady={setMap} />
      {tab === 'realtime' && map && <RealtimeView map={map} onContextChange={setRealtimeCtx} />}
      <ChatDrawer
        getContext={() => buildContext({ map, tab, date: dates[tab], realtime: realtimeCtx })}
        suggestions={suggestionsFor(tab, realtimeCtx)}
      />

      <div className="overlay-top">
        <TabSwitcher value={tab} onChange={setTab} />
        <DatePicker
          key={tab}
          value={dates[tab]}
          min={range.min}
          max={range.max}
          onChange={(date) => setDates((prev) => ({ ...prev, [tab]: date }))}
        />
      </div>
    </div>
  );
}
