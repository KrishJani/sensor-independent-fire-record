/**
 * Detection model: FIRMS VIIRS / MODIS CSV rows → one normalized shape.
 * Pure module (no Workers APIs) so it is unit-testable and usable from scripts.
 */

export type Confidence = "low" | "nominal" | "high";
export type Sensor = "VIIRS" | "MODIS";
export type Satellite = "TERRA" | "AQUA" | "SNPP" | "NOAA20" | "NOAA21";

export interface Detection {
  id: string;
  stream: string; // "live" | "replay:<id>"
  lat: number;
  lon: number;
  t: number; // epoch ms, from acq_date + acq_time (UTC)
  sensor: Sensor;
  satellite: Satellite;
  frp: number; // MW
  confidence: Confidence;
  daynight: "D" | "N";
}

/** Detection without stream/id, as stored in replay scenarios. */
export type RawDetection = Omit<Detection, "id" | "stream">;

const SATELLITES: Record<string, Satellite> = {
  terra: "TERRA",
  t: "TERRA",
  aqua: "AQUA",
  a: "AQUA",
  n: "SNPP",
  snpp: "SNPP",
  "suomi-npp": "SNPP",
  "1": "NOAA20",
  n20: "NOAA20",
  noaa20: "NOAA20",
  "noaa-20": "NOAA20",
  "2": "NOAA21",
  n21: "NOAA21",
  noaa21: "NOAA21",
  "noaa-21": "NOAA21"
};

export function normalizeSatellite(raw: string): Satellite | null {
  return SATELLITES[raw.trim().toLowerCase()] ?? null;
}

/** MODIS: 0–29 low, 30–79 nominal, 80–100 high. VIIRS: l / n / h. */
export function normalizeConfidence(raw: string | number, sensor: Sensor): Confidence | null {
  const s = String(raw).trim().toLowerCase();
  if (sensor === "MODIS" || /^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    if (n < 30) return "low";
    if (n < 80) return "nominal";
    return "high";
  }
  if (s === "l" || s === "low") return "low";
  if (s === "n" || s === "nominal") return "nominal";
  if (s === "h" || s === "high") return "high";
  return null;
}

/** acq_date "YYYY-MM-DD" + acq_time "HHMM" (leading zeros optional, e.g. "535") → epoch ms UTC. */
export function detectionTime(acqDate: string, acqTime: string | number): number {
  const hhmm = String(acqTime).trim().padStart(4, "0");
  const hh = Number(hhmm.slice(0, 2));
  const mm = Number(hhmm.slice(2, 4));
  const [y, m, d] = acqDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm);
}

/** FNV-1a, two independent 32-bit lanes → 16 hex chars. Deterministic, sync, no crypto needed. */
export function hash64(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export function detectionId(d: Pick<RawDetection, "satellite" | "lat" | "lon" | "t">): string {
  return hash64(`${d.satellite}|${d.lat.toFixed(5)}|${d.lon.toFixed(5)}|${d.t}`);
}

export function withStream(d: RawDetection, stream: string): Detection {
  return { ...d, id: detectionId(d), stream };
}

/** Minimal CSV parser for FIRMS output (no quoted fields in FIRMS CSVs). */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length < header.length) continue;
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cells[j];
    rows.push(row);
  }
  return rows;
}

export interface NormalizeResult {
  detection: RawDetection | null;
  /** Why the row was dropped, when it was. */
  reason?: "bad_row" | "non_vegetation";
}

/**
 * Normalize one FIRMS CSV row. Rows with a `type` column (SP archive) keep only
 * type 0 (presumed vegetation fire). NRT rows have no `type` and are kept.
 */
export function normalizeRow(row: Record<string, string>, sourceHint?: string): NormalizeResult {
  if (row.type !== undefined && row.type !== "" && row.type.trim() !== "0") {
    return { detection: null, reason: "non_vegetation" };
  }
  const lat = Number(row.latitude);
  const lon = Number(row.longitude);
  const instrument = (row.instrument ?? "").toUpperCase();
  const sensor: Sensor | null =
    instrument === "MODIS" || instrument === "VIIRS"
      ? instrument
      : sourceHint?.toUpperCase().startsWith("MODIS")
        ? "MODIS"
        : sourceHint?.toUpperCase().startsWith("VIIRS")
          ? "VIIRS"
          : null;
  const satellite = normalizeSatellite(row.satellite ?? "");
  if (!sensor || !satellite || !Number.isFinite(lat) || !Number.isFinite(lon) || !row.acq_date) {
    return { detection: null, reason: "bad_row" };
  }
  const confidence = normalizeConfidence(row.confidence ?? "", sensor);
  const t = detectionTime(row.acq_date, row.acq_time ?? "0");
  if (!confidence || !Number.isFinite(t)) return { detection: null, reason: "bad_row" };
  const frp = Number(row.frp);
  return {
    detection: {
      lat: round(lat, 5),
      lon: round(lon, 5),
      t,
      sensor,
      satellite,
      frp: Number.isFinite(frp) ? frp : 0,
      confidence,
      daynight: row.daynight?.trim().toUpperCase() === "D" ? "D" : "N"
    }
  };
}

export function normalizeCsv(text: string, sourceHint?: string): { detections: RawDetection[]; dropped: number; nonVegetation: number } {
  const detections: RawDetection[] = [];
  let dropped = 0;
  let nonVegetation = 0;
  for (const row of parseCsv(text)) {
    const r = normalizeRow(row, sourceHint);
    if (r.detection) detections.push(r.detection);
    else if (r.reason === "non_vegetation") nonVegetation++;
    else dropped++;
  }
  return { detections, dropped, nonVegetation };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Compact row encoding (replay scenarios, queue messages, WebSocket points)
// ---------------------------------------------------------------------------

const SAT_CODES: Satellite[] = ["TERRA", "AQUA", "SNPP", "NOAA20", "NOAA21"];
const CONF_CODES: Confidence[] = ["low", "nominal", "high"];

/** [t, lat, lon, satIdx, frp, confIdx, day(1)|night(0)] */
export type CompactRow = [number, number, number, number, number, number, number];

export function toCompact(d: RawDetection): CompactRow {
  return [
    d.t,
    d.lat,
    d.lon,
    SAT_CODES.indexOf(d.satellite),
    Math.round(d.frp * 10) / 10,
    CONF_CODES.indexOf(d.confidence),
    d.daynight === "D" ? 1 : 0
  ];
}

export function fromCompact(r: CompactRow): RawDetection {
  const satellite = SAT_CODES[r[3]];
  return {
    t: r[0],
    lat: r[1],
    lon: r[2],
    satellite,
    sensor: satellite === "TERRA" || satellite === "AQUA" ? "MODIS" : "VIIRS",
    frp: r[4],
    confidence: CONF_CODES[r[5]],
    daynight: r[6] === 1 ? "D" : "N"
  };
}

export function confidenceCode(c: Confidence): number {
  return CONF_CODES.indexOf(c);
}
