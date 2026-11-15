/**
 * Live polling (Cron, every 10 min): FIRMS NRT area API → new rows → DETECTIONS_QUEUE.
 * The queue consumer forwards them to the "live" Clusterer.
 */

import { fromCompact, normalizeCsv, toCompact, withStream, type CompactRow, type Detection } from "../detection";
import { parseBbox, type Bbox } from "../grid";

export const NRT_SOURCES = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT"] as const;
const DEFAULT_WATCH = "-170,15,-50,72"; // North America
/** Rows older than (last seen detection time − overlap) are not re-queued; the Clusterer dedupes the overlap. */
const OVERLAP_MS = 3 * 3600_000;
/** Rows per queue message: ~50 B per compact row keeps a message far below the 128 KB limit. */
const ROWS_PER_MESSAGE = 1500;
/** Messages per sendBatch: 4 × ~75 KB stays under the 256 KB batch limit. */
const MESSAGES_PER_SEND = 3;
const FIRMS_GAP_MS = 300;

export interface DetectionsMessage {
  stream: "live";
  source: string;
  rows: CompactRow[];
}

export interface PollState {
  lastT: number | null;
  lastPollAt: string;
  rowsFetched: number;
  rowsQueued: number;
  error: string | null;
}

export function watchBboxes(env: Env): Bbox[] {
  const raw = (env.WATCH_BBOXES || DEFAULT_WATCH).split(";").map((s) => parseBbox(s.trim()));
  const ok = raw.filter((b): b is Bbox => b !== null);
  return ok.length ? ok : [parseBbox(DEFAULT_WATCH)!];
}

const stateKey = (source: string, bbox: Bbox) => `realtime:poll:${source}:${bbox.join(",")}`;

function stamp(d: Date) {
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19).replace(/:/g, "") };
}

export interface PollReport {
  source: string;
  bbox: Bbox;
  status: number | null;
  fetched: number;
  kept: number;
  queued: number;
  archived: string | null;
  error: string | null;
}

export async function pollOnce(env: Env, now = new Date()): Promise<PollReport[]> {
  const key = env.FIRMS_MAP_KEY;
  if (!key) throw new Error("FIRMS_MAP_KEY is not set");
  const reports: PollReport[] = [];
  for (const bbox of watchBboxes(env)) {
    for (const source of NRT_SOURCES) {
      reports.push(await pollSource(env, key, source, bbox, now));
      await new Promise((r) => setTimeout(r, FIRMS_GAP_MS));
    }
  }
  return reports;
}

async function pollSource(env: Env, key: string, source: string, bbox: Bbox, now: Date): Promise<PollReport> {
  const report: PollReport = { source, bbox, status: null, fetched: 0, kept: 0, queued: 0, archived: null, error: null };
  const sk = stateKey(source, bbox);
  const prev = await env.INGEST_STATE.get<PollState>(sk, "json");
  try {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${source}/${bbox.join(",")}/1`;
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(url, { headers: { "User-Agent": "skywalkers77-realtime/1.0" } });
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    report.status = res!.status;
    const text = await res!.text();
    if (!text.startsWith("latitude,")) throw new Error(`FIRMS ${res!.status}: ${text.slice(0, 200)}`);

    // Archive the raw response.
    const { date, time } = stamp(now);
    report.archived = `raw/nrt/${source}/${date}/${time}.csv`;
    await env.REPLAY_DATA.put(report.archived, text, { httpMetadata: { contentType: "text/csv" } });

    const { detections } = normalizeCsv(text, source);
    report.fetched = detections.length;
    const since = prev?.lastT != null ? prev.lastT - OVERLAP_MS : Number.NEGATIVE_INFINITY;
    const fresh = detections.filter((d) => d.t >= since);
    report.kept = fresh.length;

    const rows = fresh.map(toCompact);
    const messages: DetectionsMessage[] = [];
    for (let i = 0; i < rows.length; i += ROWS_PER_MESSAGE) messages.push({ stream: "live", source, rows: rows.slice(i, i + ROWS_PER_MESSAGE) });
    for (let i = 0; i < messages.length; i += MESSAGES_PER_SEND) {
      await env.DETECTIONS_QUEUE.sendBatch(messages.slice(i, i + MESSAGES_PER_SEND).map((body) => ({ body, contentType: "json" as const })));
    }
    report.queued = rows.length;

    const maxT = detections.reduce((m, d) => Math.max(m, d.t), prev?.lastT ?? Number.NEGATIVE_INFINITY);
    const state: PollState = {
      lastT: Number.isFinite(maxT) ? maxT : null,
      lastPollAt: now.toISOString(),
      rowsFetched: report.fetched,
      rowsQueued: report.queued,
      error: null
    };
    await env.INGEST_STATE.put(sk, JSON.stringify(state));
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    const state: PollState = {
      lastT: prev?.lastT ?? null,
      lastPollAt: now.toISOString(),
      rowsFetched: 0,
      rowsQueued: 0,
      error: report.error
    };
    await env.INGEST_STATE.put(sk, JSON.stringify(state));
  }
  console.log(JSON.stringify({ job: "realtime_poll", ...report, bbox: report.bbox.join(",") }));
  return report;
}

/** Queue consumer: forward each batch to the "live" Clusterer in one call. */
export async function consumeDetections(batch: MessageBatch<DetectionsMessage>, env: Env): Promise<void> {
  const detections: Detection[] = [];
  for (const m of batch.messages) for (const r of m.body.rows) detections.push(withStream(fromCompact(r), "live"));
  if (detections.length === 0) return batch.ackAll();
  const clusterer = env.CLUSTERER.get(env.CLUSTERER.idFromName("live"));
  try {
    const res = await clusterer.ingest("live", detections);
    console.log(JSON.stringify({ job: "realtime_consume", messages: batch.messages.length, ...res }));
    batch.ackAll();
  } catch (err) {
    console.error(JSON.stringify({ job: "realtime_consume", error: String(err) }));
    batch.retryAll({ delaySeconds: 30 });
  }
}
