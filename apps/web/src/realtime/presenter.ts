import { useSyncExternalStore } from 'react';

/**
 * Presenter mode. The replay control token is never built into the bundle: the presenter opens
 * the app once with `?key=<token>`, the key is kept in localStorage and removed from the URL
 * (so it does not stay in the address bar, history or screenshots). Everyone else watches.
 * `?key=` with an empty value leaves presenter mode.
 */

const STORAGE_KEY = 'skywalkers77.presenterKey';
const listeners = new Set<() => void>();
let key: string | null = read();

function read(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function set(next: string | null) {
  key = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage blocked: presenter mode lasts for this page load only */
  }
  listeners.forEach((l) => l());
}

/** Reads `?key=` once at startup, saves it and strips it from the URL. */
function captureFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('key')) return;
  set(url.searchParams.get('key')?.trim() || null);
  url.searchParams.delete('key');
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}
captureFromUrl();

export const presenterKey = () => key;

/** Forget a key the server rejected. */
export const clearPresenterKey = () => set(null);

export function usePresenter(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => key !== null,
  );
}
