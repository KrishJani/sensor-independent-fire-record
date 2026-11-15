// Daily sensor counts and the harmonized daily series (harmonizer SPEC §7.1, §7.3).
//
// OR-based availability: on each day we use whichever sensor family is available —
// VIIRS natively if any VIIRS reference satellite has data, otherwise MODIS × α.
// Exactly one family contributes per day, so nothing is double-counted.

import { dateRange, monthOf } from './dates.ts';
import {
  ALL_SATELLITES,
  VIIRS_SATELLITES,
  type AlphaTable,
  type CellDay,
  type DailyCounts,
  type HarmonizedDay,
  type ModisConfig,
  type Satellite,
  type SourceAvailability,
} from './types.ts';

function emptySatRecord(): Record<Satellite, number> {
  return { TERRA: 0, AQUA: 0, SNPP: 0, NOAA20: 0, NOAA21: 0 };
}

/**
 * Distinct active cells per day per satellite, plus |TERRA ∪ AQUA|.
 * `cellFilter` restricts to an AOI (bbox / polygon on cell centers).
 */
export function dailySensorCounts(
  cellDays: Iterable<CellDay>,
  opts: { cellFilter?: (cellId: number, gridLat: number, gridLon: number) => boolean } = {},
): DailyCounts[] {
  const byDate = new Map<string, { sets: Map<Satellite, Set<number>>; modis: Set<number>; peak: Record<Satellite, number> }>();
  for (const cd of cellDays) {
    if (opts.cellFilter && !opts.cellFilter(cd.cellId, cd.gridLat, cd.gridLon)) continue;
    let e = byDate.get(cd.acqDate);
    if (!e) {
      e = { sets: new Map(), modis: new Set(), peak: emptySatRecord() };
      byDate.set(cd.acqDate, e);
    }
    let s = e.sets.get(cd.satellite);
    if (!s) e.sets.set(cd.satellite, (s = new Set()));
    s.add(cd.cellId);
    if (cd.sensor === 'MODIS') e.modis.add(cd.cellId);
    if (cd.peakFrpMw > e.peak[cd.satellite]) e.peak[cd.satellite] = cd.peakFrpMw;
  }
  const out: DailyCounts[] = [];
  for (const [acqDate, e] of byDate) {
    const cells = emptySatRecord();
    for (const sat of ALL_SATELLITES) cells[sat] = e.sets.get(sat)?.size ?? 0;
    out.push({ acqDate, cells, modisUnion: e.modis.size, peakFrpMw: e.peak });
  }
  return out.sort((a, b) => (a.acqDate < b.acqDate ? -1 : a.acqDate > b.acqDate ? 1 : 0));
}

export function isAvailable(av: SourceAvailability, sat: Satellite, date: string): boolean {
  return av.get(sat)?.has(date) ?? false;
}

/** First available of SNPP → NOAA20 → NOAA21. One reference per day avoids 2018/2023 constellation jumps. */
export function pickViirsReference(date: string, av: SourceAvailability): Satellite | null {
  for (const s of VIIRS_SATELLITES) if (isAvailable(av, s, date)) return s;
  return null;
}

export function modisConfigFor(date: string, av: SourceAvailability): ModisConfig | null {
  const t = isAvailable(av, 'TERRA', date);
  const a = isAvailable(av, 'AQUA', date);
  return t && a ? 'TA' : t ? 'T' : a ? 'A' : null;
}

export function modisCount(dc: DailyCounts | undefined, config: ModisConfig): number {
  if (!dc) return 0;
  return config === 'TA' ? dc.modisUnion : config === 'T' ? dc.cells.TERRA : dc.cells.AQUA;
}

function modisPeak(dc: DailyCounts | undefined, config: ModisConfig): number {
  if (!dc) return 0;
  const t = dc.peakFrpMw.TERRA;
  const a = dc.peakFrpMw.AQUA;
  return config === 'TA' ? Math.max(t, a) : config === 'T' ? t : a;
}

/**
 * Dense harmonized daily series over [from, to] — days without fires are explicit zeros,
 * days without any sensor are basis NONE (so calendars can flag them incomplete).
 */
export function harmonizeDaily(
  daily: Iterable<DailyCounts>,
  availability: SourceAvailability,
  alpha: AlphaTable,
  range: { from: string; to: string },
): HarmonizedDay[] {
  const byDate = new Map<string, DailyCounts>();
  for (const dc of daily) byDate.set(dc.acqDate, dc);
  const out: HarmonizedDay[] = [];
  for (const d of dateRange(range.from, range.to)) {
    const dc = byDate.get(d);
    const ref = pickViirsReference(d, availability);
    const cfg = modisConfigFor(d, availability);
    const M = cfg ? modisCount(dc, cfg) : 0;
    if (ref) {
      const V = dc ? dc.cells[ref] : 0;
      const p = dc ? dc.peakFrpMw[ref] : 0;
      out.push({
        acqDate: d,
        harmonizedCellDays: V,
        modisCellDays: M,
        viirsCellDays: V,
        basis: 'VIIRS',
        alpha: null,
        modisConfig: cfg,
        viirsReference: ref,
        peakFrpMw: p > 0 ? p : null,
        peakFrpSensor: p > 0 ? 'VIIRS' : null,
      });
    } else if (cfg) {
      const a = alpha[cfg][monthOf(d) - 1].alpha;
      const p = modisPeak(dc, cfg);
      out.push({
        acqDate: d,
        harmonizedCellDays: a * M,
        modisCellDays: M,
        viirsCellDays: 0,
        basis: 'MODIS_SCALED',
        alpha: a,
        modisConfig: cfg,
        viirsReference: null,
        peakFrpMw: p > 0 ? p : null,
        peakFrpSensor: p > 0 ? 'MODIS' : null,
      });
    } else {
      out.push({
        acqDate: d,
        harmonizedCellDays: 0,
        modisCellDays: 0,
        viirsCellDays: 0,
        basis: 'NONE',
        alpha: null,
        modisConfig: null,
        viirsReference: null,
        peakFrpMw: null,
        peakFrpSensor: null,
      });
    }
  }
  return out;
}

/** Build a SourceAvailability from (satellite, date) rows. */
export function availabilityFromRows(rows: Iterable<{ satellite: Satellite; acqDate: string }>): Map<Satellite, Set<string>> {
  const m = new Map<Satellite, Set<string>>();
  for (const r of rows) {
    let s = m.get(r.satellite);
    if (!s) m.set(r.satellite, (s = new Set()));
    s.add(r.acqDate);
  }
  return m;
}
