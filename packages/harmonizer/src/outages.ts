// Data-driven outage detection.
//
// A satellite that is nominally available but reports ZERO active cells in a region on a
// day when another available satellite sees ≥ minOtherCells is almost certainly missing
// granules (instrument safe-mode, processing gap, truncated download), not a fire-free day.
// Treating such days as "available with 0 fires" would bias calibration and the calendar
// downward; removing them lets the OR-availability rule fall through to the other sensor.

import { ALL_SATELLITES, type DailyCounts, type Satellite, type SourceAvailability } from './types.ts';
import { isAvailable } from './harmonize.ts';

export interface DetectedOutage {
  satellite: Satellite;
  acqDate: string;
  otherSatellite: Satellite;
  otherCells: number;
}

export function detectOutages(
  daily: Iterable<DailyCounts>,
  av: SourceAvailability,
  opts: { minOtherCells?: number } = {},
): DetectedOutage[] {
  const min = opts.minOtherCells ?? 20;
  const out: DetectedOutage[] = [];
  for (const dc of daily) {
    for (const s of ALL_SATELLITES) {
      if (!isAvailable(av, s, dc.acqDate) || dc.cells[s] > 0) continue;
      let best: Satellite | null = null;
      for (const o of ALL_SATELLITES) {
        if (o === s || !isAvailable(av, o, dc.acqDate)) continue;
        if (best === null || dc.cells[o] > dc.cells[best]) best = o;
      }
      if (best && dc.cells[best] >= min) out.push({ satellite: s, acqDate: dc.acqDate, otherSatellite: best, otherCells: dc.cells[best] });
    }
  }
  return out.sort((a, b) => (a.acqDate < b.acqDate ? -1 : a.acqDate > b.acqDate ? 1 : a.satellite < b.satellite ? -1 : 1));
}

/** Copy of `av` with the given (satellite, date) pairs removed. */
export function withoutDates(
  av: SourceAvailability,
  remove: Iterable<{ satellite: Satellite; acqDate: string }>,
): Map<Satellite, Set<string>> {
  const m = new Map<Satellite, Set<string>>();
  for (const [s, dates] of av) m.set(s, new Set(dates));
  for (const r of remove) m.get(r.satellite)?.delete(r.acqDate);
  return m;
}
