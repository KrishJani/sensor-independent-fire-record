import type mapboxgl from 'mapbox-gl';
import type { Tab } from '../lib/dataWindows';
import type { ISODate } from '../lib/dates';
import type { RealtimeContext } from '../realtime/RealtimeView';
import { viewportBbox } from '../realtime/useRealtimeStream';

/** `body.context` for FireCopilotAgent (apps/api-worker/src/copilot/context.ts). */
export interface MapContext {
  tab: Tab;
  aoi: { bbox: [number, number, number, number]; label?: string } | null;
  from: ISODate;
  to: ISODate;
  realtimeStream?: 'live' | `replay:${string}`;
}

interface Inputs {
  map: mapboxgl.Map | null;
  tab: Tab;
  /** The date picker's value for the current tab. */
  date: ISODate;
  realtime: RealtimeContext | null;
}

const STREAM_RE = /^(live|replay:[a-z0-9]{6,32})$/;

export function buildContext({ map, tab, date, realtime }: Inputs): MapContext {
  const rt = tab === 'realtime' ? realtime : null;
  // The viewport is the AOI. At world scale it is null: the realtime tool then covers the
  // whole stream, and the archival tools ask the user to pick an area.
  const bbox = map ? viewportBbox(map) : null;
  const label = rt?.label ?? undefined;
  // A replay is historical, so its scenario window beats today's date in the picker.
  const range = rt?.range ?? { from: date, to: date };

  const ctx: MapContext = {
    tab,
    aoi: bbox ? { bbox, ...(label ? { label: label.slice(0, 200) } : {}) } : null,
    from: range.from,
    to: range.to,
  };
  if (rt?.stream && STREAM_RE.test(rt.stream)) ctx.realtimeStream = rt.stream;
  return ctx;
}
