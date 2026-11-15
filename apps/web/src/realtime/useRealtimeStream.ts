import { useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { POINT_CAP, POINT_MAX_AGE_MS, REALTIME_URL } from './config';
import {
  briefTime,
  normalizeIncident,
  type Bbox,
  type Brief,
  type DetectionPoint,
  type IncidentSummary,
  type ReplayStatus,
  type ServerMessage,
  type StreamId,
} from './types';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

/**
 * Detections live outside React state: the map layer polls `version` on a timer
 * and calls setData at most ~2/s, so 60k points never cause 60k renders.
 */
export class PointBuffer {
  points: DetectionPoint[] = [];
  version = 0;

  add(points: DetectionPoint[], replace: boolean, now: number | null) {
    this.points = replace ? points.slice() : this.points.concat(points);
    this.prune(now);
    this.version++;
  }

  prune(now: number | null) {
    let pts = this.points;
    if (now !== null) {
      const cutoff = now - POINT_MAX_AGE_MS;
      if (pts.length && pts[0][3] < cutoff) pts = pts.filter((p) => p[3] >= cutoff);
    }
    // Points arrive roughly in time order, so dropping from the front keeps the newest.
    if (pts.length > POINT_CAP) pts = pts.slice(pts.length - POINT_CAP);
    if (pts !== this.points) {
      this.points = pts;
      this.version++;
    }
  }

  clear() {
    this.points = [];
    this.version++;
  }
}

export interface RealtimeStreamState {
  incidents: Map<string, IncidentSummary>;
  briefs: Map<string, Brief>;
  points: PointBuffer;
  /** Stream time: replay clock, or the latest detection time for live. */
  clock: number | null;
  replay: { status: ReplayStatus; progress: number } | null;
  connection: ConnectionStatus;
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const OFFLINE_AFTER_FAILURES = 4;
const PING_MS = 25_000;

/** Map viewport as a valid [w, s, e, n], or null (= everything) for world-scale or wrapped views. */
export function viewportBbox(map: mapboxgl.Map): Bbox | null {
  const b = map.getBounds();
  if (!b) return null;
  const w = Math.max(-180, b.getWest());
  const e = Math.min(180, b.getEast());
  const s = Math.max(-90, b.getSouth());
  const n = Math.min(90, b.getNorth());
  if (!(w < e && s < n) || b.getEast() - b.getWest() >= 300) return null;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return [r(w), r(s), r(e), r(n)];
}

export function useRealtimeStream(
  stream: StreamId | null,
  map: mapboxgl.Map | null,
): RealtimeStreamState {
  const [incidents, setIncidents] = useState<Map<string, IncidentSummary>>(() => new Map());
  const [briefs, setBriefs] = useState<Map<string, Brief>>(() => new Map());
  const [clock, setClock] = useState<number | null>(null);
  const [replay, setReplay] = useState<RealtimeStreamState['replay']>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const pointsRef = useRef(new PointBuffer());

  useEffect(() => {
    setIncidents(new Map());
    setBriefs(new Map());
    setClock(null);
    setReplay(null);
    pointsRef.current.clear();
    if (!stream) {
      setConnection('offline');
      return;
    }

    let ws: WebSocket | null = null;
    let closed = false;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let moveTimer: ReturnType<typeof setTimeout> | undefined;
    let streamT: number | null = null;
    const isReplay = stream.startsWith('replay:');
    const url = `${REALTIME_URL.replace(/^http/, 'ws')}/realtime/ws?stream=${encodeURIComponent(stream)}`;

    const sendViewport = () => {
      if (!map || ws?.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'viewport', bbox: viewportBbox(map) }));
    };

    const advance = (t: number | null | undefined) => {
      if (typeof t !== 'number' || !Number.isFinite(t)) return;
      if (streamT === null || t > streamT) {
        streamT = t;
        setClock(t);
      }
    };

    const handleFrame = (frame: ServerMessage) => {
      // Collect one frame's worth of changes so each frame is a single React update.
      const upserts: IncidentSummary[] = [];
      const newBriefs: [string, Brief][] = [];

      const visit = (m: ServerMessage) => {
        switch (m.type) {
          case 'batch':
            m.messages.forEach(visit);
            break;
          case 'hello':
            advance(m.streamT);
            break;
          case 'incident.upsert':
            upserts.push(normalizeIncident(m.incident));
            if (!isReplay) advance(m.incident.lastSeen);
            break;
          case 'incident.brief':
            newBriefs.push([m.id, m.brief]);
            break;
          case 'detections':
            if (!isReplay) for (const p of m.points) advance(p[3]);
            pointsRef.current.add(m.points, !!m.replace, streamT);
            break;
          case 'clock':
            // Stream time only moves forward; a new replay is a new stream (and a fresh effect).
            advance(m.t);
            break;
          case 'replay.status':
            setReplay({ status: m.status, progress: m.progress });
            break;
          case 'error':
            console.warn('[realtime] server error:', m.message);
            break;
        }
      };
      visit(frame);

      if (upserts.length)
        setIncidents((prev) => {
          const next = new Map(prev);
          for (const i of upserts) next.set(i.id, i);
          return next;
        });
      if (newBriefs.length)
        setBriefs((prev) => {
          const next = new Map(prev);
          // Enrichment runs can finish out of order: keep the brief describing the latest moment.
          for (const [id, b] of newBriefs) {
            const have = next.get(id);
            if (!have || briefTime(b) >= briefTime(have)) next.set(id, b);
          }
          return next;
        });
      pointsRef.current.prune(streamT);
    };

    const scheduleReconnect = () => {
      if (closed) return;
      failures++;
      setConnection(
        failures >= OFFLINE_AFTER_FAILURES || !navigator.onLine ? 'offline' : 'reconnecting',
      );
      const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
      retryTimer = setTimeout(open, base * (0.75 + Math.random() * 0.5));
    };

    function open() {
      if (closed) return;
      const socket = new WebSocket(url);
      ws = socket;
      socket.onopen = () => {
        failures = 0;
        setConnection('live');
        sendViewport();
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}');
        }, PING_MS);
      };
      socket.onmessage = (ev) => {
        try {
          handleFrame(JSON.parse(ev.data as string) as ServerMessage);
        } catch (e) {
          console.warn('[realtime] bad frame', e);
        }
      };
      socket.onclose = () => {
        clearInterval(pingTimer);
        if (ws === socket) scheduleReconnect();
      };
    }

    // Retry right away when the browser comes back online.
    const onOnline = () => {
      if (ws?.readyState === WebSocket.OPEN || closed) return;
      clearTimeout(retryTimer);
      failures = 0;
      open();
    };
    const onOffline = () => setConnection('offline');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    const onMoveEnd = () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(sendViewport, 250);
    };
    map?.on('moveend', onMoveEnd);

    setConnection('connecting');
    open();

    return () => {
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(moveTimer);
      clearInterval(pingTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      map?.off('moveend', onMoveEnd);
      const socket = ws;
      ws = null;
      socket?.close();
    };
  }, [stream, map]);

  return { incidents, briefs, points: pointsRef.current, clock, replay, connection };
}
