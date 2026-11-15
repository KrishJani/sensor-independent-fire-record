import { useEffect, useRef, useState } from 'react';
import { getIncident } from './api';
import type { IncidentDetail } from './types';

const MIN_REFRESH_MS = 4000;

/**
 * Loads GET /realtime/incidents/:id for the selected incident and refreshes it when
 * `revision` changes (new summary or brief), at most once every few seconds.
 */
export function useIncidentDetail(id: string | null, revision: string) {
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastFetch = useRef({ id: null as string | null, at: 0 });
  const currentId = useRef(id);
  currentId.current = id;

  useEffect(() => {
    if (!id) {
      setDetail(null);
      return;
    }
    const sameId = lastFetch.current.id === id;
    if (!sameId) {
      setDetail(null);
      setError(null);
    }
    const wait = sameId ? Math.max(0, lastFetch.current.at + MIN_REFRESH_MS - Date.now()) : 0;
    const timer = setTimeout(() => {
      lastFetch.current = { id, at: Date.now() };
      // In-flight requests are not aborted on a new revision (that could starve a fast replay);
      // responses for an incident that is no longer selected are dropped instead.
      getIncident(id)
        .then((d) => {
          if (currentId.current !== id) return;
          setDetail(d);
          setError(null);
        })
        .catch((e: unknown) => {
          if (currentId.current === id) setError(e instanceof Error ? e.message : String(e));
        });
    }, wait);
    return () => clearTimeout(timer);
  }, [id, revision]);

  return { detail, error };
}
