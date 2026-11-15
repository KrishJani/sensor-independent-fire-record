// Anomalies against the multi-year median (harmonizer SPEC §8.2).

import { quantileSorted } from './calibrate.ts';
import { dayOf, monthOf, yearOf } from './dates.ts';
import type { CalendarCell, HarmonizedDay } from './types.ts';

export type AnomalyClass = 'record_low' | 'much_below' | 'below' | 'normal' | 'above' | 'much_above' | 'record_high';

export interface BaselineStats {
  n: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  mean: number;
  mad: number;
  min: number;
  max: number;
}

export interface Anomaly extends BaselineStats {
  ratioToMedian: number | null;
  robustZ: number | null;
  percentile: number;
  class: AnomalyClass;
}

export function baselineStats(values: number[]): BaselineStats | null {
  if (!values.length) return null;
  const xs = [...values].sort((a, b) => a - b);
  const median = quantileSorted(xs, 0.5);
  const dev = xs.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  return {
    n: xs.length,
    median,
    p10: quantileSorted(xs, 0.1),
    p25: quantileSorted(xs, 0.25),
    p75: quantileSorted(xs, 0.75),
    p90: quantileSorted(xs, 0.9),
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    mad: quantileSorted(dev, 0.5),
    min: xs[0],
    max: xs[xs.length - 1],
  };
}

/** Score one value against a baseline sample. */
export function scoreAgainst(x: number, baseline: number[]): Anomaly | null {
  const s = baselineStats(baseline);
  if (!s) return null;
  let below = 0;
  let equal = 0;
  for (const b of baseline) {
    if (b < x) below++;
    else if (b === x) equal++;
  }
  const percentile = (100 * (below + 0.5 * equal)) / s.n;
  let cls: AnomalyClass;
  if (x > s.max) cls = 'record_high';
  else if (x < s.min) cls = 'record_low';
  else if (x > s.p90) cls = 'much_above';
  else if (x > s.p75) cls = 'above';
  else if (x < s.p10) cls = 'much_below';
  else if (x < s.p25) cls = 'below';
  else cls = 'normal';
  return {
    ...s,
    ratioToMedian: s.median === 0 ? null : x / s.median,
    robustZ: s.mad === 0 ? null : (x - s.median) / (1.4826 * s.mad),
    percentile,
    class: cls,
  };
}

export interface AnomalyOptions {
  baselineYears: [number, number];
  excludeTargetYear?: boolean; // default true
}

export function computeAnomalies(calendar: CalendarCell[], opts: AnomalyOptions) {
  const [y0, y1] = opts.baselineYears;
  const exclude = opts.excludeTargetYear ?? true;
  const byMonth: Map<number, { year: number; v: number }[]> = new Map();
  for (const c of calendar) {
    if (!c.complete || c.year < y0 || c.year > y1) continue;
    let a = byMonth.get(c.month);
    if (!a) byMonth.set(c.month, (a = []));
    a.push({ year: c.year, v: c.harmonizedCellDays });
  }
  const cells = calendar.map((c) => {
    const base = (byMonth.get(c.month) ?? []).filter((b) => !(exclude && b.year === c.year)).map((b) => b.v);
    return { ...c, anomaly: c.complete ? scoreAgainst(c.harmonizedCellDays, base) : null };
  });
  const climatology = [];
  for (let m = 1; m <= 12; m++) {
    const s = baselineStats((byMonth.get(m) ?? []).map((b) => b.v));
    if (s) climatology.push({ month: m, ...s });
  }
  return { cells, climatology };
}

/**
 * Baseline for a partial month: per baseline year, the sum over days 1..dayOfMonth of `month`.
 * Powers "this month so far vs the historical median".
 */
export function cumulativeToDay(
  days: Iterable<HarmonizedDay>,
  month: number,
  dayOfMonth: number,
  baselineYears: [number, number],
): { year: number; value: number; complete: boolean }[] {
  const acc = new Map<number, { value: number; n: number; none: boolean }>();
  for (const d of days) {
    const y = yearOf(d.acqDate);
    if (y < baselineYears[0] || y > baselineYears[1]) continue;
    if (monthOf(d.acqDate) !== month || dayOf(d.acqDate) > dayOfMonth) continue;
    let a = acc.get(y);
    if (!a) acc.set(y, (a = { value: 0, n: 0, none: false }));
    a.value += d.harmonizedCellDays;
    a.n++;
    if (d.basis === 'NONE') a.none = true;
  }
  return [...acc.entries()]
    .map(([year, a]) => ({ year, value: a.value, complete: a.n === dayOfMonth && !a.none }))
    .sort((a, b) => a.year - b.year);
}
