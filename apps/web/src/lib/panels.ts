// Panels that overlap take turns: opening one closes the others it overlaps at the current width.
//   copilot ↔ Fire Explorer: both sit on the right at every width (bottom/right stack below 900 px)
//   copilot ↔ calendar: below 1100 px the calendar runs under the copilot
const EVENT = 'fires:panel-open';

export type Panel = 'calendar' | 'chat' | 'explorer';

const CONFLICTS: { a: Panel; b: Panel; below: number }[] = [
  { a: 'chat', b: 'explorer', below: Infinity },
  { a: 'chat', b: 'calendar', below: 1100 },
];

export function overlaps(x: Panel, y: Panel, width: number): boolean {
  return CONFLICTS.some((c) => ((c.a === x && c.b === y) || (c.a === y && c.b === x)) && width < c.below);
}

/** Announce that a panel opened (call it whenever one opens, by any route). */
export function panelOpened(panel: Panel): void {
  window.dispatchEvent(new CustomEvent<Panel>(EVENT, { detail: panel }));
}

/** Run `close` when a panel that overlaps `self` opens. Returns the unsubscribe function. */
export function closeWhenOtherOpens(self: Panel, close: () => void): () => void {
  const on = (e: Event) => {
    const other = (e as CustomEvent<Panel>).detail;
    if (other !== self && overlaps(self, other, window.innerWidth)) close();
  };
  window.addEventListener(EVENT, on);
  return () => window.removeEventListener(EVENT, on);
}
