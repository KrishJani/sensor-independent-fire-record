import { useEffect, useState } from 'react';
import { getMeta, type ShowcasePeriod } from './api';

/**
 * Whether the detailed archive is loaded (/api/meta archival.detail), plus the showcase periods the map can show
 * without it. detail is null until known. If meta cannot be read, assume it is loaded so the layers try and show
 * their own errors.
 */
export function useArchiveInfo(): { detail: boolean | null; showcase: ShowcasePeriod[] } {
  const [info, setInfo] = useState<{ detail: boolean | null; showcase: ShowcasePeriod[] }>({ detail: null, showcase: [] });
  useEffect(() => {
    let live = true;
    getMeta()
      .then((m) => live && setInfo({ detail: m.archival.detail !== false, showcase: m.archival.showcase ?? [] }))
      .catch(() => live && setInfo({ detail: true, showcase: [] }));
    return () => { live = false; };
  }, []);
  return info;
}

export function useArchiveDetail(): boolean | null {
  return useArchiveInfo().detail;
}

/** The showcase period a date range overlaps, if any. */
export const showcaseFor = (showcase: ShowcasePeriod[], from: string, to: string) => showcase.find((s) => from <= s.to && to >= s.from) ?? null;
