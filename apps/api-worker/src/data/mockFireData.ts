import type { Bbox } from "../copilot/context";
import type {
  AnomalyClass,
  CalendarMonth,
  CalendarQuery,
  CalendarResult,
  FireData,
  MonthToDateResult,
  SpotsQuery,
  SpotsSummary
} from "./fireData";
import fixture from "./sample-fixture.json";

/**
 * Demo data source for the chat copilot until LiveFireData exists.
 *
 * - getSpotsSummary: REAL FIRMS detections from sample_api/ (California,
 *   2020-08-15 → 2020-08-19, plus a handful of MODIS NRT rows from 2026-11-13),
 *   pre-aggregated by scripts/build-fixtures.mjs.
 * - getCalendar / getMonthToDate: SYNTHETIC, deterministic, California-shaped
 *   numbers (season peaks Jul–Sep, standout months such as Aug/Sep 2020,
 *   Nov 2018, Dec 2017). They are NOT observations.
 */

type FixtureCellDay = {
  lat: number;
  lon: number;
  date: string;
  satellite: string;
  n: number;
  maxFrp: number;
  lastTime: string;
};
type FixtureDetection = {
  lat: number;
  lon: number;
  date: string;
  time: string;
  satellite: string;
  sensor: string;
  tier: string;
  frp: number;
  confidence: number;
  dayNight: string;
};

const CELL_DAYS = fixture.cellDays as FixtureCellDay[];
const TOP_DETECTIONS = fixture.topDetections as FixtureDetection[];

export const ARCHIVAL_MIN = "2000-11-01";
export const ARCHIVAL_MAX = "2026-08-31"; // mirrors the /api/meta example in SPEC §3
export const VIIRS_START = "2012-01-20";
const BASELINE: [number, number] = [2001, 2025];
const CALIFORNIA: Bbox = [-124.5, 32.5, -114.0, 42.1];

/** Typical monthly harmonized cell-days for all of California (synthetic). */
const SEASON = [14, 10, 16, 28, 55, 120, 330, 520, 450, 230, 85, 22];
/** MODIS→VIIRS calibration factors α_m (synthetic, plausible magnitude). */
const ALPHA = [2.7, 2.6, 2.5, 2.4, 2.3, 2.2, 2.1, 2.1, 2.2, 2.3, 2.5, 2.6];

/** Months that stand out in the real California record; multipliers are synthetic. */
const STANDOUTS: Record<string, number> = {
  "2003-10": 4.5, // Cedar / Old fires
  "2007-10": 4, // Witch / Harris fires
  "2008-06": 3.5, // June 2008 lightning siege
  "2008-07": 2.5,
  "2017-10": 4, // Tubbs / Atlas (wine country)
  "2017-12": 9, // Thomas fire
  "2018-07": 2.6, // Carr / Mendocino Complex
  "2018-08": 2.4,
  "2018-11": 7, // Camp / Woolsey
  "2020-08": 6.5, // August Complex, LNU, SCU, CZU
  "2020-09": 5.5, // Creek, North Complex
  "2020-10": 2.5,
  "2021-07": 2.6, // Dixie
  "2021-08": 3.2, // Dixie, Caldor
  "2024-07": 2.4, // Park fire
  "2025-01": 12 // Palisades / Eaton
};

const MOCK_NOTE_CALENDAR =
  "DEMO DATA: these calendar numbers are SYNTHETIC (deterministic, California-like seasonality and standout months). They are not satellite observations. Live Postgres/D1 data is not connected yet.";
const MOCK_NOTE_SPOTS =
  "DEMO DATA SOURCE: counts and detections are REAL NASA FIRMS hotspots from the bundled sample (California, 2020-08-15 to 2020-08-19, MODIS + VIIRS S-NPP; plus 8 MODIS NRT rows from 2026-11-13). Outside those dates the sample has no data, which does NOT mean there were no fires.";
const MOCK_NOTE_MTD =
  "DEMO DATA: month-to-date numbers are SYNTHETIC (deterministic). Live D1 realtime data is not connected yet.";

// ---------- deterministic helpers ----------

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic pseudo-random in [0, 1) for a key. */
function rand(key: string): number {
  let t = hash(key) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Fraction of California covered by the AOI (min 0.01 so tiny AOIs still get signal). */
function areaScale(bbox: Bbox): number {
  const [w, s, e, n] = bbox;
  const [cw, cs, ce, cn] = CALIFORNIA;
  const ow = Math.max(0, Math.min(e, ce) - Math.max(w, cw));
  const oh = Math.max(0, Math.min(n, cn) - Math.max(s, cs));
  if (ow === 0 || oh === 0) return 0;
  return Math.max(0.01, (ow * oh) / ((ce - cw) * (cn - cs)));
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function classify(percentile: number, ratio: number, z: number): AnomalyClass {
  if (percentile >= 100) return "record_high";
  if (percentile <= 0) return "record_low";
  if (z >= 1.5 || ratio >= 2) return "above";
  if (z <= -1.5 || ratio <= 0.4) return "below";
  return "normal";
}

/** Synthetic harmonized cell-days for one month in one AOI. */
function syntheticMonth(year: number, month: number, scale: number): number {
  const key = ym(year, month);
  const noise = 0.45 + 1.2 * rand(`m:${key}`); // 0.45–1.65
  const yearTrend = 0.8 + 0.4 * rand(`y:${year}`) + (year >= 2015 ? 0.15 : 0);
  const standout = STANDOUTS[key] ?? 1;
  return Math.round(SEASON[month - 1]! * scale * noise * yearTrend * standout);
}

function clampDate(d: string, lo: string, hi: string): string {
  return d < lo ? lo : d > hi ? hi : d;
}

// ---------- the mock ----------

export class MockFireData implements FireData {
  readonly source = "mock" as const;

  async getCalendar(q: CalendarQuery): Promise<CalendarResult> {
    const scale = areaScale(q.bbox);
    const from = clampDate(q.from, ARCHIVAL_MIN, ARCHIVAL_MAX);
    const to = clampDate(q.to, ARCHIVAL_MIN, ARCHIVAL_MAX);
    const monthFilter = q.months?.length ? new Set(q.months) : null;

    // Baseline per calendar month (always 2001–2025, independent of the requested range).
    const baseline = new Map<number, number[]>();
    for (let m = 1; m <= 12; m++) {
      const vals: number[] = [];
      for (let y = BASELINE[0]; y <= BASELINE[1]; y++) vals.push(syntheticMonth(y, m, scale));
      baseline.set(m, vals.sort((a, b) => a - b));
    }
    const climatology = [...baseline.entries()].map(([month, v]) => ({
      month,
      median: round1(quantile(v, 0.5)),
      p10: round1(quantile(v, 0.1)),
      p25: round1(quantile(v, 0.25)),
      p75: round1(quantile(v, 0.75)),
      p90: round1(quantile(v, 0.9))
    }));
    const p75OfMedians = quantile(
      climatology.map((c) => c.median).sort((a, b) => a - b),
      0.75
    );
    const criticalMonths = climatology.filter((c) => c.median > p75OfMedians).map((c) => c.month);

    const months: CalendarMonth[] = [];
    const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
    const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
    for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) {
      if (monthFilter && !monthFilter.has(m)) continue;
      const value = syntheticMonth(y, m, scale);
      const key = ym(y, m);
      const preViirs = key < VIIRS_START.slice(0, 7);
      const sourceMix = preViirs ? 0 : key === VIIRS_START.slice(0, 7) ? 0.39 : 1;
      const viirs = preViirs ? 0 : Math.round(value * sourceMix);
      const modis = Math.round(value / ALPHA[m - 1]!);
      const partialEdge =
        (key === from.slice(0, 7) && !from.endsWith("-01")) ||
        (key === to.slice(0, 7) && Number(to.slice(8)) < daysInMonth(y, m));
      // Terra MODIS outage 2001-06-15 → 2001-07-03, Aqua not yet in orbit.
      const outage = key === "2001-06" || key === "2001-07";
      const base = baseline.get(m)!;
      const median = quantile(base, 0.5);
      const mad = quantile(base.map((v) => Math.abs(v - median)).sort((a, b) => a - b), 0.5) || 1;
      const below = base.filter((v) => v < value).length;
      // In-baseline months are part of `base`, so a record equals the max.
      const percentile =
        value > 0 && value >= base[base.length - 1]! ? 100 : Math.round((below / base.length) * 100);
      const ratio = median > 0 ? value / median : 0;
      const z = (value - median) / (1.4826 * mad);
      months.push({
        year: y,
        month: m,
        harmonizedCellDays: value,
        modisCellDays: modis,
        viirsCellDays: viirs,
        sourceMix,
        peakFrpMw: round1(value === 0 ? 0 : 40 + value * (6 + 10 * rand(`f:${key}`))),
        peakFrpSensor: preViirs ? "MODIS" : "VIIRS",
        complete: !partialEdge && !outage,
        calibratedEstimate: preViirs,
        anomaly: {
          median: round1(median),
          ratioToMedian: round2(ratio),
          robustZ: round1(z),
          percentile,
          class: classify(percentile, ratio, z)
        }
      });
    }

    const annualMap = new Map<number, number>();
    for (const mo of months) annualMap.set(mo.year, (annualMap.get(mo.year) ?? 0) + mo.harmonizedCellDays);
    const annual = [...annualMap.entries()].map(([year, harmonizedCellDays]) => ({
      year,
      harmonizedCellDays,
      calibratedEstimate: year < 2012
    }));

    const peak = months.reduce<CalendarMonth | null>(
      (a, b) => (!a || b.harmonizedCellDays > a.harmonizedCellDays ? b : a),
      null
    );
    const peakYear = annual.reduce<(typeof annual)[number] | null>(
      (a, b) => (!a || b.harmonizedCellDays > a.harmonizedCellDays ? b : a),
      null
    );
    const notableMonths = [...months]
      .sort(
        (a, b) =>
          b.anomaly.robustZ - a.anomaly.robustZ || b.harmonizedCellDays - a.harmonizedCellDays
      )
      .slice(0, 8)
      .sort((a, b) => a.year - b.year || a.month - b.month);

    return {
      dataSource: "mock",
      note:
        scale === 0
          ? `${MOCK_NOTE_CALENDAR} The AOI is outside the configured region (California), so all values are 0.`
          : MOCK_NOTE_CALENDAR,
      mode: "archival",
      bbox: q.bbox,
      from,
      to,
      unit: "active cell-days (0.05° ≈ 5.5 km cell with ≥1 detection on a UTC day)",
      summary: {
        peakMonth: peak ? ym(peak.year, peak.month) : null,
        peakYear: peakYear?.year ?? null,
        criticalMonths,
        totalHarmonizedCellDays: months.reduce((s, m) => s + m.harmonizedCellDays, 0),
        monthsInRange: months.length,
        incompleteMonths: months.filter((m) => !m.complete).length
      },
      climatology,
      annual,
      notableMonths
    };
  }

  async getSpotsSummary(q: SpotsQuery): Promise<SpotsSummary> {
    const [w, s, e, n] = q.bbox;
    const inBox = (lat: number, lon: number) => lat >= s && lat <= n && lon >= w && lon <= e;
    // Archival tier = dates covered by SP in Postgres; realtime = after that (D1 window).
    const inTier = (date: string) => (q.mode === "archival" ? date <= ARCHIVAL_MAX : date > ARCHIVAL_MAX);
    const inRange = (date: string) => date >= q.from && date <= q.to && inTier(date);

    const cells = CELL_DAYS.filter((c) => inRange(c.date) && inBox(c.lat, c.lon));
    const bySatellite: SpotsSummary["counts"]["bySatellite"] = {};
    const daily = new Map<string, { cells: Set<string>; peak: number }>();
    let lastSeen: string | null = null;
    for (const c of cells) {
      const sat = (bySatellite[c.satellite] ??= { detections: 0, cellDays: 0 });
      sat.detections += c.n;
      sat.cellDays += 1;
      let d = daily.get(c.date);
      if (!d) daily.set(c.date, (d = { cells: new Set(), peak: 0 }));
      d.cells.add(`${c.lat},${c.lon}`);
      d.peak = Math.max(d.peak, c.maxFrp);
      const iso = `${c.date}T${c.lastTime.slice(0, 2)}:${c.lastTime.slice(2)}:00Z`;
      if (!lastSeen || iso > lastSeen) lastSeen = iso;
    }
    // Harmonized-style count: distinct (cell, date) across satellites.
    const activeCellDays = [...daily.values()].reduce((sum, d) => sum + d.cells.size, 0);

    const top = TOP_DETECTIONS.filter((d) => inRange(d.date) && inBox(d.lat, d.lon))
      .slice(0, 8)
      .map((d) => ({
        lat: d.lat,
        lon: d.lon,
        date: d.date,
        timeUtc: `${d.time.slice(0, 2)}:${d.time.slice(2)}`,
        satellite: d.satellite,
        sensor: d.sensor as "MODIS" | "VIIRS",
        frpMw: d.frp,
        confidence: d.confidence
      }));

    return {
      dataSource: "mock",
      note: MOCK_NOTE_SPOTS,
      mode: q.mode,
      bbox: q.bbox,
      from: q.from,
      to: q.to,
      counts: {
        detections: cells.reduce((sum, c) => sum + c.n, 0),
        activeCellDays,
        distinctCells: new Set(cells.map((c) => `${c.lat},${c.lon}`)).size,
        bySatellite
      },
      daily: [...daily.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, d]) => ({ date, activeCells: d.cells.size, peakFrpMw: d.peak })),
      lastSeen,
      topDetections: top
    };
  }

  async getMonthToDate(q: { bbox: Bbox; today?: string }): Promise<MonthToDateResult> {
    const today = q.today ?? new Date().toISOString().slice(0, 10);
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7));
    const throughDay = Math.max(1, Number(today.slice(8, 10)) - 1); // NRT lags ~1 day
    const scale = areaScale(q.bbox);
    const dim = daysInMonth(y, m);
    const perDay = (yy: number, d: number) =>
      Math.round(((SEASON[m - 1]! * scale) / dim) * (0.3 + 1.4 * rand(`d:${yy}-${m}-${d}`)));

    const daily = Array.from({ length: throughDay }, (_, i) => ({
      date: `${ym(y, m)}-${String(i + 1).padStart(2, "0")}`,
      harmonizedCellDays: perDay(y, i + 1)
    }));
    const value = daily.reduce((s, d) => s + d.harmonizedCellDays, 0);
    const history: number[] = [];
    for (let yy = BASELINE[0]; yy <= BASELINE[1]; yy++) {
      let sum = 0;
      for (let d = 1; d <= throughDay; d++) sum += perDay(yy, d);
      history.push(sum);
    }
    history.sort((a, b) => a - b);
    const median = quantile(history, 0.5);
    const ratio = median > 0 ? value / median : 0;
    const pct = Math.round((history.filter((v) => v < value).length / history.length) * 100);

    return {
      dataSource: "mock",
      note: MOCK_NOTE_MTD,
      bbox: q.bbox,
      month: ym(y, m),
      throughDay,
      monthToDate: {
        value,
        median: round1(median),
        ratioToMedian: round2(ratio),
        class: classify(value > 0 && value >= history[history.length - 1]! ? 100 : pct, ratio, 0)
      },
      daily,
      basis: "VIIRS"
    };
  }
}
