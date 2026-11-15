const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** realtime-worker base URL (apps/realtime-worker/REALTIME.md). */
export const REALTIME_URL = trimSlash(import.meta.env.VITE_REALTIME_URL || 'http://localhost:8789');

/** api-worker base URL (chat copilot, apps/api-worker/CHAT.md). */
export const API_URL = trimSlash(import.meta.env.VITE_API_URL || 'http://localhost:8787');


/** Max detections kept on the map. The Quebec replay emits ~60k. */
export const POINT_CAP = 20_000;

/** Detections older than this (stream time) are dropped, matching the server's active window. */
export const POINT_MAX_AGE_MS = 48 * 3600_000;

/** setData at most this often. */
export const MAP_UPDATE_MS = 500;
