/** UI actions shared by the welcome card, the help panel and the copilot's client-side tools (see App.tsx). */
export interface AppActions {
  /** Realtime tab, Live stream. */
  showLive(): void;
  /** Realtime tab, Replay mode; with a scenario id, start it (or join it if it is running). */
  showReplay(scenario?: string): void;
  /** Archival tab on a showcase period, calendar open. */
  openShowcase(id: string): void;
}
