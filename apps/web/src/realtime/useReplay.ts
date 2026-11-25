import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, controlReplay, getReplay, setReplaySpeed, startOrJoinReplay } from './api';
import type { ReplayInfo } from './types';

const STORAGE_KEY = 'skywalkers77.realtime.replay.v1';
const STATUS_POLL_MS = 10_000;

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
    if (e.code === 'replay_cooldown') {
      const s = /(\d+) s/.exec(e.message)?.[1];
      return `A replay was started a moment ago. Try again in ${s ? `${s} seconds` : 'a few seconds'}.`;
    }
    return e.message;
  }
  if (e instanceof TypeError) return 'Cannot reach the realtime service.';
  return e instanceof Error ? e.message : String(e);
}

/** What a start request did: started a new replay, joined the running one, is waiting out the cooldown, or failed. */
export type StartResult =
  | { kind: 'started' | 'joined'; info: ReplayInfo }
  | { kind: 'cooldown'; seconds: number }
  | { kind: 'error'; message: string };

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

  // The WebSocket normally reports the end, but a page that joined late or lost the socket may
  // miss it; polling keeps the status honest so the HUD never shows a frozen "Playing" clock.
  const liveId = info && (info.status === 'running' || info.status === 'paused') ? info.id : null;
  useEffect(() => {
    if (!liveId) return;
    const t = setInterval(() => {
      getReplay(liveId)
        .then((r) => setInfo((prev) => (prev?.id === r.id ? r : prev)))
        .catch(() => {});
    }, STATUS_POLL_MS);
    return () => clearInterval(t);
  }, [liveId]);

  // A start that hit the shared 30 s cooldown waits and retries by itself; `startsIn` drives "Starting in Xs".
  const [startsIn, setStartsIn] = useState<number | null>(null);
  const pending = useRef<{ timer: ReturnType<typeof setInterval>; cancelled: boolean } | null>(null);
  const cancelPending = useCallback(() => {
    if (pending.current) {
      pending.current.cancelled = true;
      clearInterval(pending.current.timer);
      pending.current = null;
    }
    setStartsIn(null);
  }, []);
  useEffect(() => cancelPending, [cancelPending]);

  const setMode = useCallback((m: 'live' | 'replay') => {
    if (m === 'live') cancelPending();
    setModeState(m);
    setError(null);
    save({ mode: m, id: load().id });
  }, [cancelPending]);

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

  /** Join the scenario if it is running, otherwise start it; during the cooldown, count down and retry. */
  const start = useCallback(
    async (scenario: string, speed?: number): Promise<StartResult> => {
      cancelPending();
      setModeState('replay');
      save({ mode: 'replay', id: load().id });
      setBusy(true);
      setError(null);
      try {
        const r = await startOrJoinReplay(scenario, speed);
        setInfo(r);
        save({ mode: 'replay', id: r.id });
        return { kind: r.reused ? 'joined' : 'started', info: r };
      } catch (e) {
        if (e instanceof ApiError && e.code === 'replay_cooldown') {
          const wait = Math.max(1, Number(/(\d+) s/.exec(e.message)?.[1] ?? 30));
          const until = Date.now() + wait * 1000;
          setStartsIn(wait);
          const p = { cancelled: false, timer: setInterval(() => {
            const left = Math.ceil((until - Date.now()) / 1000);
            if (left > 0) return setStartsIn(left);
            clearInterval(p.timer);
            if (p.cancelled) return;
            pending.current = null;
            setStartsIn(null);
            void startRef.current(scenario, speed);
          }, 250) };
          pending.current = p;
          return { kind: 'cooldown', seconds: wait };
        }
        const m = message(e);
        setError(m);
        return { kind: 'error', message: m };
      } finally {
        setBusy(false);
      }
    },
    [cancelPending],
  );
  const startRef = useRef(start);
  startRef.current = start;
  const control = useCallback(
    (action: 'pause' | 'resume' | 'stop') => (info ? run(() => controlReplay(info.id, action)) : null),
    [info, run],
  );
  const setSpeed = useCallback(
    (speed: number) => (info ? run(() => setReplaySpeed(info.id, speed)) : null),
    [info, run],
  );

  return { mode, setMode, info, busy, error, start, startsIn, control, setSpeed };
}
