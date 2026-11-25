import type { AppActions } from '../help/actions';

/** Client-side copilot tools (schemas in apps/api-worker/src/copilot/ui.ts). Their names, for the chat's tool lines. */
export const UI_TOOL_NAMES = new Set(['switch_view', 'open_showcase', 'fly_to', 'start_replay']);

export interface UiToolOutput {
  ok: boolean;
  /** The tool line in the chat, e.g. "Switched to Replay". */
  summary: string;
  /** Extra facts for the model (e.g. the replay starts in 20 s). */
  note?: string;
}

const VIEW_LABEL = { live: 'Live', replay: 'Replay', archival: 'Archival' } as const;

/** Run one UI tool call against the app. Never throws: a failure comes back as { ok: false }. */
export async function runUiTool(name: string, input: unknown, actions: AppActions): Promise<UiToolOutput> {
  const a = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'switch_view': {
        const view = a.view as keyof typeof VIEW_LABEL;
        if (!(view in VIEW_LABEL)) return { ok: false, summary: 'Could not switch the view' };
        if (view === 'live') actions.showLive();
        else if (view === 'replay') actions.showReplay();
        else actions.showArchival();
        return { ok: true, summary: `Switched to ${VIEW_LABEL[view]}` };
      }
      case 'open_showcase': {
        const label = actions.openShowcase(String(a.period));
        return label ? { ok: true, summary: `Opened ${label}` } : { ok: false, summary: 'Could not open that period' };
      }
      case 'fly_to': {
        const lon = Number(a.lon), lat = Number(a.lat);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { ok: false, summary: 'Could not move the map' };
        const zoom = Number.isFinite(Number(a.zoom)) ? Number(a.zoom) : 7;
        await actions.flyTo(lon, lat, zoom);
        const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 80) : `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`;
        return { ok: true, summary: `Moved the map to ${label}` };
      }
      case 'start_replay': {
        const r = await actions.startReplay(String(a.scenario));
        if (r.kind === 'started') return { ok: true, summary: 'Started the Quebec 2023 replay' };
        if (r.kind === 'joined') return { ok: true, summary: 'Joined the Quebec 2023 replay already running' };
        if (r.kind === 'cooldown')
          return { ok: true, summary: `Quebec 2023 replay starts in ${r.seconds}s`, note: `Another replay was started moments ago; this one starts automatically in about ${r.seconds} seconds.` };
        return { ok: false, summary: 'Could not start the replay', note: r.kind === 'error' ? r.message : undefined };
      }
    }
  } catch (e) {
    return { ok: false, summary: `Could not run ${name}`, note: e instanceof Error ? e.message : String(e) };
  }
  return { ok: false, summary: `Unknown action ${name}` };
}
