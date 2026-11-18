import { REALTIME_URL } from './config';
import { normalizeIncident, type IncidentDetail, type ReplayInfo } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${REALTIME_URL}${path}`, init);
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: { code: string; message: string } })
    | null;
  if (!res.ok || !body) {
    const e = body?.error;
    throw new ApiError(e?.message ?? `HTTP ${res.status}`, res.status, e?.code);
  }
  return body;
}

/** Replay controls are open to every visitor (one replay at a time, see the realtime-worker). */
function replayPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export async function getIncident(id: string, signal?: AbortSignal): Promise<IncidentDetail> {
  const d = await request<IncidentDetail>(`/realtime/incidents/${encodeURIComponent(id)}`, { signal });
  return { ...d, summary: normalizeIncident(d.summary) };
}

interface Health {
  activeReplay?: { id: string; scenario: string } | null;
}

export const getHealth = () => request<Health>('/realtime/health');
export const getReplay = (id: string) => request<ReplayInfo>(`/realtime/replay/${id}`);

export const startReplay = (scenario: string, speed?: number) =>
  replayPost<ReplayInfo>('/realtime/replay', { scenario, ...(speed ? { speed } : {}) });

export const controlReplay = (id: string, action: 'pause' | 'resume' | 'stop') =>
  replayPost<ReplayInfo>(`/realtime/replay/${id}/${action}`);

export const setReplaySpeed = (id: string, speed: number) =>
  replayPost<ReplayInfo>(`/realtime/replay/${id}/speed`, { speed });

/**
 * Join the replay of `scenario` that is already running (or paused), else start one.
 * Newer workers also reuse on POST and answer 409 when another scenario holds the slot.
 */
export async function startOrJoinReplay(scenario: string, speed?: number): Promise<ReplayInfo> {
  try {
    const active = (await getHealth()).activeReplay;
    if (active?.scenario === scenario) {
      const info = await getReplay(active.id);
      if (info.status === 'running' || info.status === 'paused') return { ...info, reused: true };
    }
  } catch {
    /* older worker or transient error: fall through to POST */
  }
  return startReplay(scenario, speed);
}
