// Active cell-days (harmonizer SPEC §6).

import { cellCenter, toCellId } from './grid.ts';
import { sensorOf, type CellDay, type Detection, type Satellite, type Tier } from './types.ts';

/** Gap that separates two overpasses of one satellite over one cell. */
export const PASS_GAP_MINUTES = 30;

export const hhmmToMinutes = (t: number) => Math.floor(t / 100) * 60 + (t % 100);

interface Bucket {
  acqDate: string;
  cellId: number;
  satellite: Satellite;
  tier: Tier;
  items: number[]; // flattened [acqTime, frp, acqTime, frp, ...]
}

/** Incremental cell-day builder: add detections in any order, then build(). */
export function createCellDayAccumulator() {
  const buckets = new Map<string, Bucket>();
  return {
    add(d: Detection) {
      const cellId = toCellId(d.lat, d.lon);
      const key = `${d.acqDate}|${cellId}|${d.satellite}|${d.tier}`;
      let b = buckets.get(key);
      if (!b) {
        b = { acqDate: d.acqDate, cellId, satellite: d.satellite, tier: d.tier, items: [] };
        buckets.set(key, b);
      }
      b.items.push(d.acqTime, d.frpMw);
    },
    get size() {
      return buckets.size;
    },
    build(): CellDay[] {
      const out: CellDay[] = [];
      for (const b of buckets.values()) out.push(finalize(b));
      return out.sort(compareCellDays);
    },
  };
}

function finalize(b: Bucket): CellDay {
  const n = b.items.length / 2;
  const pairs: [number, number][] = new Array(n);
  for (let i = 0; i < n; i++) pairs[i] = [b.items[2 * i], b.items[2 * i + 1]];
  // Sort by time, then FRP → summation order (and so float results) is input-order independent.
  pairs.sort((a, c) => a[0] - c[0] || a[1] - c[1]);

  let nPasses = 0;
  let peak = 0;
  let sum = 0;
  let passFrp = 0;
  let prevMin = -Infinity;
  for (const [t, frp] of pairs) {
    const m = hhmmToMinutes(t);
    if (m - prevMin > PASS_GAP_MINUTES) {
      if (nPasses > 0 && passFrp > peak) peak = passFrp;
      nPasses++;
      passFrp = 0;
    }
    passFrp += frp;
    sum += frp;
    prevMin = m;
  }
  if (passFrp > peak) peak = passFrp;

  const { lat, lon } = cellCenter(b.cellId);
  return {
    acqDate: b.acqDate,
    cellId: b.cellId,
    gridLat: lat,
    gridLon: lon,
    satellite: b.satellite,
    sensor: sensorOf(b.satellite),
    tier: b.tier,
    nDetections: n,
    nPasses,
    peakFrpMw: peak,
    sumFrpMw: sum,
    firstTime: pairs[0][0],
    lastTime: pairs[n - 1][0],
  };
}

const SAT_ORDER: Record<Satellite, number> = { TERRA: 0, AQUA: 1, SNPP: 2, NOAA20: 3, NOAA21: 4 };

export function compareCellDays(a: CellDay, b: CellDay): number {
  if (a.acqDate !== b.acqDate) return a.acqDate < b.acqDate ? -1 : 1;
  if (a.cellId !== b.cellId) return a.cellId - b.cellId;
  if (a.satellite !== b.satellite) return SAT_ORDER[a.satellite] - SAT_ORDER[b.satellite];
  return a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0;
}

/** Deterministic, sorted by (acqDate, cellId, satellite). */
export function buildCellDays(dets: Iterable<Detection>): CellDay[] {
  const acc = createCellDayAccumulator();
  for (const d of dets) acc.add(d);
  return acc.build();
}
