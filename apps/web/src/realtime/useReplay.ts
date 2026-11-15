import { useCallback, useEffect, useState } from 'react';
import { ApiError, controlReplay, getReplay, startOrJoinReplay } from './api';
import { clearPresenterKey, presenterKey } from './presenter';
import type { ReplayInfo } from './types';

const STORAGE_KEY = 'skywalkers77.realtime.replay.v1';

function load(): { mode: 'live' | 'replay'; id: string | null } {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage blocked */
  }
  return { mode: 'live', id: null };
}

function save(v: { mode: 'live' | 'replay'; id: string | null }) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* storage blocked */
  }
}

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'replay_busy') return `${e.message}. Stop it first or wait for it to finish.`;
    if (e.status === 401) {
      if (presenterKey()) {
        clearPresenterKey();
        return 'The presenter key was rejected. Open the presenter link again.';
      }
      return 'Only the presenter can start or control the replay right now.';
    }
    return e.message;
  }
  if (e instanceof TypeError) return 'Cannot reach the realtime service.';
  return e instanceof Error ? e.message : String(e);
}

/**
 * Live/Replay mode plus the current replay. Mode and replay id survive switching tabs
 * (sessionStorage), and a running replay is rejoined rather than restarted.
 */
export function useReplay() {
  const [mode, setModeState] = useState<'live' | 'replay'>(() => load().mode);
  const [info, setInfo] = useState<ReplayInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const { id } = load();
    if (!id) return;
    let alive = true;
    getReplay(id)
      .then((r) => alive && setInfo(r))
      .catch(() => alive && save({ mode: load().mode, id: null }));
    return () => {
      alive = false;
    };
  }, []);

  const setMode = useCallback((m: 'live' | 'replay') => {
    setModeState(m);
    setError(null);
    save({ mode: m, id: load().id });
  }, []);

  const run = useCallback(async (fn: () => Promise<ReplayInfo>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setInfo(r);
      save({ mode: 'replay', id: r.id });
      return r;
    } catch (e) {
      setError(message(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const start = useCallback(
    (scenario: string, speed?: number) => run(() => startOrJoinReplay(scenario, speed)),
    [run],
  );
  const control = useCallback(
    (action: 'pause' | 'resume' | 'stop') => (info ? run(() => controlReplay(info.id, action)) : null),
    [info, run],
  );

  return { mode, setMode, info, busy, error, start, control };
}
