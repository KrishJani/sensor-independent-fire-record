import { useMemo, useState } from 'react';
import { DatePicker } from './components/DatePicker';
import { MapView } from './components/MapView';
import { TabSwitcher } from './components/TabSwitcher';
import { dateWindow, type Tab } from './lib/dataWindows';
import type { ISODate } from './lib/dates';

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

  return (
    <div className="app">
      <MapView />

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
