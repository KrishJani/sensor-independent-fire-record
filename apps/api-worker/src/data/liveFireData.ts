import type { Bbox } from "../copilot/context";
import { withDb } from "../lib/db.ts";
import { ApiError } from "../lib/http.ts";
import { calendar } from "../routes/calendar.ts";
import { CONFIG } from "../routes/meta.ts";
import type {
  AnomalyClass,
  CalendarMonth,
  CalendarQuery,
  CalendarResult,
  FireData,
  MonthToDateResult,
  SpotsQuery,
  SpotsSummary,
  Unavailable
} from "./fireData";
import { classifyAgainst, regionMonthToDate, regionOfBbox, regionRef } from "./regionContext";

const round1 = (x: number) => Math.round(x * 10) / 10;
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const unavailable = (message: string): Unavailable => ({ dataSource: "live", available: false, message });

const OUTSIDE = "This area is outside the harmonized archive (US regions only), so there is no calendar for it. Use get_spots_summary for current detections.";

/**
 * Real data for the copilot tools (SPEC §4.5), calling the same code as the HTTP routes in-process.
 *  - calendar / month-to-date: the precomputed REGION calendars in Postgres (the per-cell detail needed for an
 *    arbitrary AOI is not loaded), so every result names the region it describes.
 *  - hotspots: the D1 near-real-time tier (last D1_RETENTION_DAYS days). Older hotspot detail is not loaded.
 */
export class LiveFireData implements FireData {
  readonly source = "live" as const;
  constructor(private env: Env) {}

  async getCalendar(q: CalendarQuery): Promise<CalendarResult | Unavailable> {
    const region = regionOfBbox(q.bbox);
    if (!region) return unavailable(OUTSIDE);
    let body: Awaited<ReturnType<typeof calendar>>;
    try {
      body = await withDb((ctx) => calendar(this.env, ctx, { scope: region.id, from: q.from, to: q.to, months: q.months ?? null }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) return unavailable(`The archive has no data for ${q.from} to ${q.to}: ${err.message}`);
      throw err;
    }
    const ref = regionRef(region);
    const months: CalendarMonth[] = body.calendar.map((c) => ({
      year: c.year,
      month: c.month,
      harmonizedCellDays: c.harmonizedCellDays,
      modisCellDays: c.modisCellDays,
      viirsCellDays: c.viirsCellDays,
      sourceMix: c.sourceMix,
      peakFrpMw: c.peakFrpMw ?? 0,
      peakFrpSensor: (c.peakFrpSensor ?? "MODIS") as "MODIS" | "VIIRS",
      complete: c.complete,
      calibratedEstimate: c.year * 100 + c.month < 201201,
      anomaly: {
        median: c.anomaly?.median ?? 0,
        ratioToMedian: c.anomaly?.ratioToMedian ?? 0,
        robustZ: c.anomaly?.robustZ ?? 0,
        percentile: c.anomaly?.percentile ?? 0,
        class: (c.anomaly?.class ?? "normal") as AnomalyClass
      }
    }));
    const notableMonths = [...months]
      .sort((a, b) => b.anomaly.robustZ - a.anomaly.robustZ || b.harmonizedCellDays - a.harmonizedCellDays)
      .slice(0, 8)
      .sort((a, b) => a.year - b.year || a.month - b.month);
    const baseline = (CONFIG.baselineYears as number[]).join("-");
    return {
      dataSource: "live",
      note:
        `Region-level data: these numbers describe the whole ${ref.label} (${ref.name}), not the selected area itself; say "the ${ref.label}" when you cite them. ` +
        `Harmonized NASA FIRMS MODIS+VIIRS record from the Postgres archive; anomalies are against the ${baseline} median for each calendar month. viirsCellDays and modisCellDays are each sensor's own count for the same days: they overlap and do not add up to harmonizedCellDays.`,
      region: ref,
      mode: "archival",
      bbox: q.bbox,
      from: body.range.from,
      to: body.range.to,
      unit: "active cell-days (0.05° ≈ 5.5 km cell with ≥1 detection on a UTC day)",
      summary: {
        peakMonth: body.summary.peakMonth,
        peakYear: body.summary.peakYear,
        criticalMonths: body.summary.criticalMonths,
        totalHarmonizedCellDays: Math.round(months.reduce((s, m) => s + m.harmonizedCellDays, 0)),
        monthsInRange: months.length,
        incompleteMonths: months.filter((m) => !m.complete).length
      },
      climatology: body.climatology.map((c) => ({ month: c.month, median: c.median, p10: c.p10, p25: c.p25, p75: c.p75, p90: c.p90 })),
      annual: body.annual.map((a) => ({ year: a.year, harmonizedCellDays: a.harmonizedCellDays, calibratedEstimate: a.year < 2012 })),
      notableMonths
    };
  }

  async getSpotsSummary(q: SpotsQuery): Promise<SpotsSummary | Unavailable> {
    const today = new Date().toISOString().slice(0, 10);
    const min = addDays(today, -Number(this.env.D1_RETENTION_DAYS ?? 92));
    const from = q.from < min ? min : q.from;
    const to = q.to > today ? today : q.to;
    if (from > to) {
      return unavailable(
        q.mode === "archival"
          ? "Hotspot detail for past periods is not loaded here, so use get_calendar for monthly activity in the region."
          : `Near-real-time hotspots only cover the last ${this.env.D1_RETENTION_DAYS ?? 92} days (since ${min}).`
      );
    }
    // The D1 tier is filled by ingest-worker; an empty tier must not read as "no fires".
    const have = (await this.env.NRT_DB.prepare("SELECT count(*) AS n FROM nrt_availability WHERE acq_date BETWEEN ?1 AND ?2").bind(from, to).all<{ n: number }>()).results[0]?.n ?? 0;
    if (!have) return unavailable("The near-real-time hotspot database has no data for these dates here, so use get_live_incidents for current fires.");
    const [w, s, e, n] = q.bbox;
    const where = `acq_date BETWEEN ?1 AND ?2 AND lat BETWEEN ?3 AND ?4 AND lon BETWEEN ?5 AND ?6 AND heat_class = 'fire'`;
    const bind = [from, to, s, n, w, e];
    const db = this.env.NRT_DB;
    const [sats, daily, top, tot, last] = await db.batch<any>([
      db.prepare(`SELECT satellite, count(*) AS n, count(DISTINCT cell_id || '|' || acq_date) AS cd FROM nrt_detections WHERE ${where} GROUP BY satellite`).bind(...bind),
      db.prepare(`SELECT acq_date AS d, count(DISTINCT cell_id) AS cells, max(frp_mw) AS pk FROM nrt_detections WHERE ${where} GROUP BY acq_date ORDER BY acq_date`).bind(...bind),
      db.prepare(`SELECT lat, lon, satellite, sensor, acq_date, acq_time, frp_mw, confidence FROM nrt_detections WHERE ${where} ORDER BY frp_mw DESC LIMIT 10`).bind(...bind),
      db.prepare(`SELECT count(*) AS n, count(DISTINCT cell_id) AS cells, count(DISTINCT cell_id || '|' || acq_date) AS cd FROM nrt_detections WHERE ${where}`).bind(...bind),
      db.prepare(`SELECT acq_date, acq_time FROM nrt_detections WHERE ${where} ORDER BY acq_date DESC, acq_time DESC LIMIT 1`).bind(...bind)
    ]);
    const hhmm = (t: number) => `${String(Math.floor(t / 100)).padStart(2, "0")}:${String(t % 100).padStart(2, "0")}`;
    const t = tot!.results[0] as { n: number; cells: number; cd: number };
    const l = last!.results[0] as { acq_date: string; acq_time: number } | undefined;
    const clamped = from !== q.from || to !== q.to;
    return {
      dataSource: "live",
      note:
        `Near-real-time NASA FIRMS detections (D1, last ${this.env.D1_RETENTION_DAYS ?? 92} days; fire class only, gas-flare and industrial heat excluded). Counts are raw detections from every satellite and are not harmonized across sensors; ` +
        `activeCells = distinct 0.05° cells with a detection that UTC day. FRP is not comparable across sensors.` +
        (clamped ? ` The requested range ${q.from} to ${q.to} was clipped to ${from} to ${to}.` : "") +
        (q.mode === "archival" ? " Older hotspot detail is not loaded; use get_calendar for monthly history." : ""),
      mode: "realtime",
      bbox: q.bbox as Bbox,
      from,
      to,
      counts: {
        detections: t.n,
        activeCellDays: t.cd,
        distinctCells: t.cells,
        bySatellite: Object.fromEntries((sats!.results as { satellite: string; n: number; cd: number }[]).map((r) => [r.satellite, { detections: r.n, cellDays: r.cd }]))
      },
      daily: (daily!.results as { d: string; cells: number; pk: number }[]).map((r) => ({ date: r.d, activeCells: r.cells, peakFrpMw: round1(r.pk) })),
      lastSeen: l ? `${l.acq_date}T${hhmm(l.acq_time)}:00Z` : null,
      topDetections: (top!.results as any[]).map((r) => ({
        lat: r.lat,
        lon: r.lon,
        date: r.acq_date,
        timeUtc: hhmm(r.acq_time),
        satellite: r.satellite,
        sensor: r.sensor,
        frpMw: round1(r.frp_mw),
        confidence: r.confidence
      }))
    };
  }

  async getMonthToDate(q: { bbox: Bbox; today?: string }): Promise<MonthToDateResult | Unavailable> {
    const region = regionOfBbox(q.bbox);
    if (!region) return unavailable(OUTSIDE);
    const now = q.today ? new Date(`${q.today}T12:00:00Z`) : new Date();
    const mtd = await regionMonthToDate(this.env, region, now);
    if (!mtd) return unavailable("No near-real-time data is ingested for this month, so a month-to-date comparison is not possible; get_calendar has the archive.");
    const [y, m] = [Number(mtd.month.slice(0, 4)), Number(mtd.month.slice(5, 7))];
    const cal = await withDb((ctx) => calendar(this.env, ctx, { scope: region.id }));
    const clim = cal.climatology.find((c) => c.month === m);
    if (!clim) return unavailable("No baseline exists for this month.");
    const f = mtd.throughDay / daysIn(y, m);
    const median = round1(clim.median * f);
    const ref = regionRef(region);
    const baseline = (CONFIG.baselineYears as number[]).join("-");
    return {
      dataSource: "live",
      note:
        `Region-level: this is the whole ${ref.label} (${ref.name}), not the selected area; say "the ${ref.label}". ` +
        `Value = VIIRS-equivalent active cell-days from near-real-time data through day ${mtd.throughDay} (complete UTC days). Median = the ${baseline} median for the full month × ${mtd.throughDay}/${daysIn(y, m)} (prorated linearly). ` +
        `The national border is approximate (0.5° bins).` +
        (mtd.daysWithoutViirs.length ? ` Days with no VIIRS data: ${mtd.daysWithoutViirs.join(", ")}.` : ""),
      region: ref,
      bbox: q.bbox,
      month: mtd.month,
      throughDay: mtd.throughDay,
      monthToDate: {
        value: mtd.value,
        median,
        ratioToMedian: median > 0 ? Math.round((mtd.value / median) * 100) / 100 : 0,
        class: classifyAgainst(mtd.value, clim, f)
      },
      daily: mtd.daily,
      basis: "VIIRS"
    };
  }
}
