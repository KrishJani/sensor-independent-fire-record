// The calendar drawer and the copilot overlap below this width, so opening one closes the other.
const NARROW_PX = 1100;
const EVENT = 'fires:panel-open';

export type Panel = 'calendar' | 'chat';

/** Announce that a panel opened (call it whenever one opens, by any route). */
export function panelOpened(panel: Panel): void {
  window.dispatchEvent(new CustomEvent<Panel>(EVENT, { detail: panel }));
}

/** Run `close` when the other panel opens on a narrow screen. Returns the unsubscribe function. */
export function closeWhenOtherOpens(self: Panel, close: () => void): () => void {
  const on = (e: Event) => {
    if ((e as CustomEvent<Panel>).detail !== self && window.innerWidth < NARROW_PX) close();
  };
  window.addEventListener(EVENT, on);
  return () => window.removeEventListener(EVENT, on);
}
