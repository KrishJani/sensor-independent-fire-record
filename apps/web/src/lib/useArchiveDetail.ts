import { useEffect, useState } from 'react';
import { getMeta } from './api';

/**
 * Whether the detailed archive is loaded (/api/meta archival.detail). null until known. If meta
 * cannot be read, assume it is loaded so the layers try and show their own errors.
 */
export function useArchiveDetail(): boolean | null {
  const [detail, setDetail] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    getMeta().then((m) => live && setDetail(m.archival.detail !== false)).catch(() => live && setDetail(true));
    return () => { live = false; };
  }, []);
  return detail;
}
