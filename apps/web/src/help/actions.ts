import type { StartResult } from '../realtime/useReplay';

/** UI actions shared by the welcome card and the copilot's client-side tools (implemented in App.tsx). */
export interface AppActions {
  /** Realtime tab, Live stream. */
  showLive(): void;
  /** Realtime tab, Replay mode, without starting anything. */
  showReplay(): void;
  /** Realtime tab, start the scenario or join it if it is running; resolves with what happened. */
  startReplay(scenario: string): Promise<StartResult>;
  /** Archival tab. */
  showArchival(): void;
  /** Archival tab on a showcase period with the calendar open; returns the period's label, or null if unknown. */
  openShowcase(id: string): string | null;
  /** Move the camera; resolves when the move ends. */
  flyTo(lon: number, lat: number, zoom: number): Promise<void>;
}
