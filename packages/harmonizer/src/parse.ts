// Streaming FIRMS CSV parser (harmonizer SPEC §3).
// Accepts Area-API CSVs and Archive-Download CSVs for MODIS and VIIRS, SP and NRT.

import type { Detection, Satellite, SensorFamily, Tier } from './types.ts';

export type RejectReason =
  | 'column_count'
  | 'bad_lat'
  | 'bad_lon'
  | 'bad_date'
  | 'bad_time'
  | 'bad_frp'
  | 'bad_confidence'
  | 'bad_satellite'
  | 'bad_daynight'
  | 'bad_type';

export interface ParseStats {
  rows: number;
  parsed: number;
  rejected: Partial<Record<RejectReason, number>>;
}

export function newParseStats(): ParseStats {
  return { rows: 0, parsed: 0, rejected: {} };
}

export interface ParseOptions {
  tier: Tier;
  /** FIRMS source id of the file (e.g. 'VIIRS_NOAA20_SP'). Used when `instrument`/`satellite` is missing. */
  sourceHint?: string;
  stats?: ParseStats;
  /** Called for every rejected row (line is 1-based, header = line 1). */
  onReject?: (lineNo: number, reason: RejectReason, line: string) => void;
}

interface ColumnIndex {
  lat: number;
  lon: number;
  date: number;
  time: number;
  satellite: number;
  instrument: number;
  confidence: number;
  version: number;
  frp: number;
  daynight: number;
  type: number;
  headerSensor: SensorFamily | null;
}

function indexHeader(headerLine: string): ColumnIndex {
  const cols = splitCsvLine(stripBom(headerLine)).map((c) => c.trim().toLowerCase());
  const at = (...names: string[]) => {
    for (const n of names) {
      const i = cols.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const idx: ColumnIndex = {
    lat: at('latitude', 'lat'),
    lon: at('longitude', 'lon'),
    date: at('acq_date'),
    time: at('acq_time'),
    satellite: at('satellite'),
    instrument: at('instrument'),
    confidence: at('confidence'),
    version: at('version'),
    frp: at('frp'),
    daynight: at('daynight'),
    type: at('type'),
    headerSensor: cols.includes('bright_ti4') ? 'VIIRS' : cols.includes('brightness') ? 'MODIS' : null,
  };
  const required: (keyof ColumnIndex)[] = ['lat', 'lon', 'date', 'time', 'confidence', 'frp'];
  const missing = required.filter((k) => (idx[k] as number) < 0);
  if (missing.length) throw new Error(`FIRMS CSV header missing columns: ${missing.join(', ')} — got "${headerLine}"`);
  return idx;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Split one CSV line. FIRMS never quotes, but tolerate simple double-quoted fields. */
export function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function sensorFromHint(hint?: string): SensorFamily | null {
  if (!hint) return null;
  const h = hint.toUpperCase();
  if (h.startsWith('MODIS')) return 'MODIS';
  if (h.startsWith('VIIRS')) return 'VIIRS';
  return null;
}

function satelliteFromHint(hint?: string): Satellite | null {
  if (!hint) return null;
  const h = hint.toUpperCase();
  if (h.includes('NOAA20')) return 'NOAA20';
  if (h.includes('NOAA21')) return 'NOAA21';
  if (h.includes('SNPP')) return 'SNPP';
  return null;
}

/** Normalize the FIRMS satellite code. The raw code is ambiguous across sensors, so sensor disambiguates. */
export function normalizeSatellite(raw: string, sensor: SensorFamily): Satellite | null {
  const s = raw.trim().toUpperCase().replace(/[\s_-]/g, '');
  if (sensor === 'MODIS') {
    if (s === 'TERRA' || s === 'T') return 'TERRA';
    if (s === 'AQUA' || s === 'A') return 'AQUA';
    return null;
  }
  if (s === 'N' || s === 'NPP' || s === 'SNPP' || s === 'SUOMINPP') return 'SNPP';
  if (s === '1' || s === 'N20' || s === 'NOAA20' || s === 'J1' || s === 'JPSS1') return 'NOAA20';
  if (s === '2' || s === 'N21' || s === 'NOAA21' || s === 'J2' || s === 'JPSS2') return 'NOAA21';
  return null;
}

const VIIRS_CONF: Record<string, number> = { l: 20, low: 20, n: 60, nominal: 60, h: 90, high: 90 };

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const y = +s.slice(0, 4);
  const m = +s.slice(5, 7);
  const d = +s.slice(8, 10);
  if (y < 1999 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function parseTime(raw: string): number | null {
  const t = raw.trim().replace(':', '');
  if (!/^\d{1,4}$/.test(t)) return null;
  const v = parseInt(t, 10);
  if (v % 100 >= 60 || v >= 2400) return null;
  return v;
}

/**
 * Stateful line-level parser. Feed it the header first, then each data line.
 * Used by both the string/stream helpers below and by Node backfill readers.
 */
export function createFirmsLineParser(opts: ParseOptions) {
  let idx: ColumnIndex | null = null;
  let lineNo = 0;
  const stats = opts.stats;
  const hintSensor = sensorFromHint(opts.sourceHint);
  const hintSat = satelliteFromHint(opts.sourceHint);

  const reject = (reason: RejectReason, line: string): null => {
    if (stats) stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1;
    opts.onReject?.(lineNo, reason, line);
    return null;
  };

  return {
    get hasHeader() {
      return idx !== null;
    },
    /** Returns a Detection, or null for header/blank/rejected lines. */
    line(rawLine: string): Detection | null {
      lineNo++;
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (idx === null) {
        if (line.trim() === '') return null;
        idx = indexHeader(line);
        return null;
      }
      if (line.trim() === '') return null;
      if (stats) stats.rows++;
      const f = splitCsvLine(line);
      if (f.length < 6) return reject('column_count', line);

      const lat = Number(f[idx.lat]);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || f[idx.lat].trim() === '') return reject('bad_lat', line);
      const lon = Number(f[idx.lon]);
      if (!Number.isFinite(lon) || lon < -180 || lon > 180 || f[idx.lon].trim() === '') return reject('bad_lon', line);

      const acqDate = (f[idx.date] ?? '').trim();
      if (!isValidDate(acqDate)) return reject('bad_date', line);
      const acqTime = parseTime(f[idx.time] ?? '');
      if (acqTime === null) return reject('bad_time', line);

      const frpRaw = (f[idx.frp] ?? '').trim();
      const frpMw = Number(frpRaw);
      if (frpRaw === '' || !Number.isFinite(frpMw) || frpMw < 0) return reject('bad_frp', line);

      const instrument = idx.instrument >= 0 ? (f[idx.instrument] ?? '').trim().toUpperCase() : '';
      const sensor: SensorFamily | null =
        instrument === 'MODIS' ? 'MODIS' : instrument === 'VIIRS' ? 'VIIRS' : idx.headerSensor ?? hintSensor;
      if (!sensor) return reject('bad_satellite', line);

      let satellite: Satellite | null = null;
      if (idx.satellite >= 0) satellite = normalizeSatellite(f[idx.satellite] ?? '', sensor);
      if (!satellite && sensor === 'VIIRS') satellite = hintSat;
      if (!satellite) return reject('bad_satellite', line);

      const confRaw = (f[idx.confidence] ?? '').trim();
      let confidence: number;
      if (sensor === 'VIIRS') {
        const c = VIIRS_CONF[confRaw.toLowerCase()];
        if (c === undefined) return reject('bad_confidence', line);
        confidence = c;
      } else {
        confidence = Number(confRaw);
        if (confRaw === '' || !Number.isFinite(confidence) || confidence < 0 || confidence > 100)
          return reject('bad_confidence', line);
      }

      let dayNight: 'D' | 'N' = 'D';
      if (idx.daynight >= 0) {
        const dn = (f[idx.daynight] ?? '').trim().toUpperCase();
        if (dn !== 'D' && dn !== 'N') return reject('bad_daynight', line);
        dayNight = dn;
      }

      let type: Detection['type'] = null;
      if (idx.type >= 0) {
        const t = (f[idx.type] ?? '').trim();
        if (t !== '') {
          if (t !== '0' && t !== '1' && t !== '2' && t !== '3') return reject('bad_type', line);
          type = Number(t) as 0 | 1 | 2 | 3;
        }
      }

      if (stats) stats.parsed++;
      return {
        lat,
        lon,
        acqDate,
        acqTime,
        satellite,
        sensor,
        confidence,
        frpMw,
        dayNight,
        type,
        tier: opts.tier,
        version: idx.version >= 0 ? (f[idx.version] ?? '').trim() : '',
      };
    },
  };
}

/** Parse a whole CSV string. Lazily yields detections. */
export function* parseFirmsCsv(text: string, opts: ParseOptions): Generator<Detection> {
  const p = createFirmsLineParser(opts);
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const d = p.line(text.slice(start, end));
    if (d) yield d;
    start = end + 1;
  }
}

/** Parse a chunked stream (e.g. a fetch() body in a Worker) without buffering it whole. */
export async function* parseFirmsCsvStream(
  chunks: AsyncIterable<string | Uint8Array>,
  opts: ParseOptions,
): AsyncGenerator<Detection> {
  const p = createFirmsLineParser(opts);
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of chunks) {
    buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const d = p.line(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (d) yield d;
    }
  }
  buf += dec.decode();
  if (buf.length) {
    const d = p.line(buf);
    if (d) yield d;
  }
}
