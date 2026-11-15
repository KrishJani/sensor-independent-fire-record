import { DurableObject } from "cloudflare:workers";
import { assignDetections, type ClusterStore, type IncidentRef } from "../cluster";
import { confidenceCode, type Detection } from "../detection";
import { bboxIntersects, type Bbox } from "../grid";
import { INACTIVE_AFTER_MS, type IncidentStatus, type IncidentSummary } from "../incidentModel";
import type { MapPoint } from "../protocol";
import { briefMinAreaKm2, incidentId } from "../streams";
import type { IncidentIngestResult } from "./incident";

/** Dedupe ids are kept this long (stream time) before pruning. */
const DEDUPE_RETENTION_MS = 10 * 24 * 3600_000;
const INCIDENT_FANOUT = 24;
/** Max enrichment workflows started per ingest batch, so the largest queued incidents go first. */
const ENRICH_DISPATCH_PER_BATCH = 2;
/** The live stream's ENRICH_MAX_PER_STREAM applies per rolling 24 h of wall clock. */
const LIVE_ENRICH_WINDOW_MS = 24 * 3600_000;

export interface IngestResult {
  stream: string;
  accepted: number;
  duplicates: number;
  lowConfidence: number;
  created: number;
  merges: number;
  incidentsTouched: number;
  streamT: number | null;
}

export interface ListQuery {
  bbox?: Bbox | null;
  status?: IncidentStatus | "all";
  includeMinor?: boolean;
  limit?: number;
}

/**
 * One per stream ("live", "replay:<id>"). Owns dedupe, the cell → incident index and the
 * incident list, and fans each batch out to Incident DOs (once per incident per batch).
 */
export class Clusterer extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS detections (id TEXT PRIMARY KEY, t INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS detections_t ON detections (t);
      CREATE TABLE IF NOT EXISTS cells (cell TEXT PRIMARY KEY, incident_id TEXT NOT NULL, last_t INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY, first_t INTEGER NOT NULL, last_t INTEGER NOT NULL, merged_into TEXT,
        significant INTEGER NOT NULL DEFAULT 0, summary TEXT, w REAL, s REAL, e REAL, n REAL,
        sent_status TEXT
      );
      CREATE TABLE IF NOT EXISTS merges (from_id TEXT NOT NULL, into_id TEXT NOT NULL, t INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS enrich_queue (incident_id TEXT PRIMARY KEY, reason TEXT NOT NULL, queued_t INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS enrich_log (t INTEGER NOT NULL, incident_id TEXT NOT NULL);
    `);
  }

  private meta(k: string): string | null {
    const r = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray();
    return r[0]?.v ?? null;
  }
  private setMeta(k: string, v: string) {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }
  private bump(name: string, by: number) {
    if (by) this.sql.exec("INSERT INTO counters (name, n) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET n = n + excluded.n", name, by);
  }

  private streamT(): number | null {
    const v = this.meta("streamT");
    return v === null ? null : Number(v);
  }

  private store(stream: string): ClusterStore {
    const sql = this.sql;
    const self = this;
    return {
      insertDetection(d: Detection) {
        return sql.exec("INSERT OR IGNORE INTO detections (id, t) VALUES (?, ?)", d.id, d.t).rowsWritten > 0;
      },
      getCellIncident(cell) {
        return sql.exec<{ incident_id: string }>("SELECT incident_id FROM cells WHERE cell = ?", cell).toArray()[0]?.incident_id ?? null;
      },
      setCell(cell, incident, t) {
        sql.exec(
          `INSERT INTO cells (cell, incident_id, last_t) VALUES (?, ?, ?)
           ON CONFLICT(cell) DO UPDATE SET incident_id = excluded.incident_id, last_t = MAX(last_t, excluded.last_t)`,
          cell,
          incident,
          t
        );
      },
      getIncident(id): IncidentRef | null {
        const r = sql
          .exec<{ id: string; first_t: number; last_t: number; merged_into: string | null }>(
            "SELECT id, first_t, last_t, merged_into FROM incidents WHERE id = ?",
            id
          )
          .toArray()[0];
        return r ? { id: r.id, firstT: r.first_t, lastT: r.last_t, mergedInto: r.merged_into } : null;
      },
      createIncident(t) {
        const seq = Number(self.meta("seq") ?? "0") + 1;
        self.setMeta("seq", String(seq));
        const id = incidentId(stream, seq);
        sql.exec("INSERT INTO incidents (id, first_t, last_t) VALUES (?, ?, ?)", id, t, t);
        return id;
      },
      touchIncident(id, t) {
        sql.exec("UPDATE incidents SET last_t = MAX(last_t, ?), first_t = MIN(first_t, ?) WHERE id = ?", t, t, id);
      },
      recordMerge(from, into, t) {
        sql.exec("UPDATE incidents SET merged_into = ? WHERE id = ?", into, from);
        sql.exec("INSERT INTO merges (from_id, into_id, t) VALUES (?, ?, ?)", from, into, t);
      }
    };
  }

  /** Feed a batch of detections (any order) for this stream. */
  async ingest(stream: string, batch: Detection[]): Promise<IngestResult> {
    if (!this.meta("stream")) this.setMeta("stream", stream);

    const res = this.ctx.storage.transactionSync(() => assignDetections(this.store(stream), batch));
    const prevT = this.streamT();
    const streamT = res.maxT === null ? prevT : Math.max(prevT ?? res.maxT, res.maxT);
    if (streamT !== null) this.setMeta("streamT", String(streamT));
    this.bump("detections", res.fresh.length);
    this.bump("low_confidence", res.lowConfidence);
    this.bump("duplicates", res.duplicates);

    // Fan out: one Incident DO call per incident per batch.
    const entries = [...res.byIncident.entries()];
    const results: IncidentIngestResult[] = [];
    const minAreaKm2 = briefMinAreaKm2(this.env, stream);
    for (let i = 0; i < entries.length; i += INCIDENT_FANOUT) {
      const chunk = entries.slice(i, i + INCIDENT_FANOUT);
      const out = await Promise.all(
        chunk.map(([id, ds]) => this.incidentStub(id).ingest({ id, stream, detections: ds, streamT: streamT ?? ds.at(-1)!.t, minAreaKm2 }))
      );
      results.push(...(out as unknown as IncidentIngestResult[]));
    }
    const summaries = results.map((r) => r.summary);
    this.queueEnrichments(results);
    await Promise.all(res.merges.map((m) => this.incidentStub(m.from).markMerged(m.into, m.t)));

    const upserts: IncidentSummary[] = [];
    for (const s of summaries) {
      this.sql.exec(
        `UPDATE incidents SET significant = ?, summary = ?, w = ?, s = ?, e = ?, n = ?, sent_status = CASE WHEN ? THEN ? ELSE sent_status END WHERE id = ?`,
        s.significant ? 1 : 0,
        JSON.stringify(s),
        s.bbox[0],
        s.bbox[1],
        s.bbox[2],
        s.bbox[3],
        s.significant ? 1 : 0,
        s.status,
        s.id
      );
      if (s.significant) upserts.push(s);
    }
    // Merged incidents: mark in the stored summary and broadcast once.
    for (const m of res.merges) {
      const row = this.sql.exec<{ summary: string | null; significant: number }>("SELECT summary, significant FROM incidents WHERE id = ?", m.from).toArray()[0];
      if (row?.summary) {
        const s = { ...(JSON.parse(row.summary) as IncidentSummary), status: "merged" as const, mergedInto: m.into };
        this.sql.exec("UPDATE incidents SET summary = ?, sent_status = 'merged' WHERE id = ?", JSON.stringify(s), m.from);
        if (row.significant) upserts.push(s);
      }
    }
    // Incidents that went quiet for 48 h of stream time flip to inactive.
    if (streamT !== null) upserts.push(...this.expireInactive(streamT));
    // After the summaries are stored, so the queue is ranked by current area.
    await this.dispatchEnrichments(stream, streamT);

    if (streamT !== null && res.fresh.length > 0 && streamT - (Number(this.meta("prunedAt") ?? 0)) > 24 * 3600_000) {
      this.sql.exec("DELETE FROM detections WHERE t < ?", streamT - DEDUPE_RETENTION_MS);
      this.setMeta("prunedAt", String(streamT));
    }

    const points: MapPoint[] = res.fresh.map((d) => [d.lon, d.lat, d.frp, d.t, confidenceCode(d.confidence)]);
    if (upserts.length || points.length) {
      await this.hub(stream).publish({ upserts, points });
    }

    return {
      stream,
      accepted: res.fresh.length,
      duplicates: res.duplicates,
      lowConfidence: res.lowConfidence,
      created: res.created.length,
      merges: res.merges.length,
      incidentsTouched: res.byIncident.size,
      streamT
    };
  }

  /** Due enrichments wait in enrich_queue; dispatchEnrichments() starts them largest first. */
  private queueEnrichments(results: IncidentIngestResult[]) {
    for (const r of results) {
      if (!r.enrich) continue;
      // A first brief outranks a re-brief; keep "significant" if one is already waiting.
      this.sql.exec(
        `INSERT INTO enrich_queue (incident_id, reason, queued_t) VALUES (?, ?, ?)
         ON CONFLICT(incident_id) DO UPDATE SET reason = CASE WHEN enrich_queue.reason = 'significant' THEN 'significant' ELSE excluded.reason END`,
        r.summary.id,
        r.enrich.reason,
        r.enrich.streamT
      );
      this.bump("enrichments_queued", 1);
    }
  }

  /** Enrichments started for this stream within its cap window (live: rolling 24 h; replay: whole stream). */
  private enrichmentsUsed(stream: string): number {
    const since = stream === "live" ? Date.now() - LIVE_ENRICH_WINDOW_MS : 0;
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM enrich_log WHERE t > ?", since).one().n;
  }

  /**
   * Start INCIDENT_ENRICH for queued incidents, biggest affected area first (first briefs before
   * re-briefs), at most ENRICH_DISPATCH_PER_BATCH per call, within ENRICH_MAX_PER_STREAM for this
   * stream and the global BRIEF_DAILY_MAX. What does not fit stays queued for a later batch.
   */
  private async dispatchEnrichments(stream: string, streamT: number | null) {
    const queued = this.sql
      .exec<{ incident_id: string; reason: string; summary: string | null; merged_into: string | null }>(
        `SELECT q.incident_id, q.reason, i.summary, i.merged_into FROM enrich_queue q JOIN incidents i ON i.id = q.incident_id`
      )
      .toArray();
    if (!queued.length) return;
    const ranked = queued
      .filter((q) => {
        if (q.merged_into || !q.summary) {
          this.sql.exec("DELETE FROM enrich_queue WHERE incident_id = ?", q.incident_id);
          return false;
        }
        return true;
      })
      .map((q) => ({ ...q, s: JSON.parse(q.summary!) as IncidentSummary }))
      .sort((a, b) => Number(a.reason !== "significant") - Number(b.reason !== "significant") || b.s.affectedAreaKm2 - a.s.affectedAreaKm2);

    const perStreamMax = Number(this.env.ENRICH_MAX_PER_STREAM ?? 30);
    const dailyMax = Number(this.env.BRIEF_DAILY_MAX ?? 60);
    for (const q of ranked.slice(0, ENRICH_DISPATCH_PER_BATCH)) {
      if (this.enrichmentsUsed(stream) >= perStreamMax) {
        this.bump("enrich_deferred_stream_cap", 1);
        return;
      }
      const grant = await this.control().tryConsumeBrief(dailyMax);
      if (!grant.ok) {
        this.bump("enrich_deferred_daily_budget", 1);
        return;
      }
      this.sql.exec("DELETE FROM enrich_queue WHERE incident_id = ?", q.incident_id);
      this.sql.exec("INSERT INTO enrich_log (t, incident_id) VALUES (?, ?)", Date.now(), q.incident_id);
      this.bump("enrichments", 1);
      const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM enrich_log WHERE incident_id = ?", q.incident_id).one().n;
      const instanceId = `${q.incident_id.replace(/[^a-zA-Z0-9-]/g, "_")}-${n}`;
      const at = Math.max(streamT ?? 0, q.s.asOf);
      try {
        await this.env.INCIDENT_ENRICH.create({
          id: instanceId,
          params: { incidentId: q.incident_id, stream, reason: q.reason as "significant" | "area_doubled", streamT: at, summary: { ...q.s, asOf: at } }
        });
        console.log(JSON.stringify({ msg: "enrich_started", incident: q.incident_id, reason: q.reason, affectedAreaKm2: q.s.affectedAreaKm2, briefsUsed24h: grant.used, queued: ranked.length }));
      } catch (err) {
        console.error(JSON.stringify({ msg: "enrich_start_failed", incident: q.incident_id, error: String(err) }));
      }
    }
  }

  private expireInactive(streamT: number): IncidentSummary[] {
    const rows = this.sql
      .exec<{ id: string; summary: string }>(
        "SELECT id, summary FROM incidents WHERE significant = 1 AND merged_into IS NULL AND sent_status = 'active' AND last_t < ?",
        streamT - INACTIVE_AFTER_MS
      )
      .toArray();
    return rows.map((r) => {
      const s = { ...(JSON.parse(r.summary) as IncidentSummary), status: "inactive" as const, asOf: streamT };
      this.sql.exec("UPDATE incidents SET summary = ?, sent_status = 'inactive' WHERE id = ?", JSON.stringify(s), r.id);
      return s;
    });
  }

  /** Advance stream time without detections (live polls with no new rows; replay clock). */
  async advanceClock(stream: string, t: number): Promise<void> {
    const prev = this.streamT();
    if (prev !== null && t <= prev) return;
    this.setMeta("streamT", String(t));
    const upserts = this.expireInactive(t);
    if (upserts.length) await this.hub(stream).publish({ upserts });
  }

  async list(q: ListQuery = {}): Promise<{ stream: string | null; streamT: number | null; incidents: IncidentSummary[] }> {
    const streamT = this.streamT();
    const where = ["summary IS NOT NULL"];
    if (!q.includeMinor) where.push("significant = 1");
    const rows = this.sql
      .exec<{ summary: string }>(`SELECT summary FROM incidents WHERE ${where.join(" AND ")} ORDER BY last_t DESC`)
      .toArray();
    let out = rows.map((r) => JSON.parse(r.summary) as IncidentSummary).map((s) => withStatus(s, streamT));
    if (q.bbox) out = out.filter((s) => bboxIntersects(s.bbox, q.bbox!));
    if (q.status && q.status !== "all") out = out.filter((s) => s.status === q.status);
    out.sort((a, b) => b.affectedAreaKm2 - a.affectedAreaKm2 || b.lastSeen - a.lastSeen);
    return { stream: this.meta("stream"), streamT, incidents: out.slice(0, q.limit ?? 500) };
  }

  async stats() {
    const counters = Object.fromEntries(
      this.sql.exec<{ name: string; n: number }>("SELECT name, n FROM counters").toArray().map((r) => [r.name, r.n])
    );
    const inc = this.sql
      .exec<{ total: number; significant: number }>("SELECT COUNT(*) AS total, COALESCE(SUM(significant), 0) AS significant FROM incidents")
      .one();
    const merges = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM merges").one().n;
    const stream = this.meta("stream");
    const enrich = {
      queued: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM enrich_queue").one().n,
      used: stream ? this.enrichmentsUsed(stream) : 0,
      max: Number(this.env.ENRICH_MAX_PER_STREAM ?? 30),
      window: stream === "live" ? "24h" : "stream"
    };
    return { stream, streamT: this.streamT(), counters, incidents: inc, merges, enrich };
  }

  async getStreamT(): Promise<number | null> {
    return this.streamT();
  }

  private control() {
    return this.env.CONTROL.get(this.env.CONTROL.idFromName("global"));
  }
  private incidentStub(id: string) {
    return this.env.INCIDENT.get(this.env.INCIDENT.idFromName(id));
  }
  private hub(stream: string) {
    return this.env.LIVE_HUB.get(this.env.LIVE_HUB.idFromName(stream));
  }
}

function withStatus(s: IncidentSummary, streamT: number | null): IncidentSummary {
  if (s.status === "merged" || streamT === null) return s;
  return { ...s, status: streamT - s.lastSeen > INACTIVE_AFTER_MS ? "inactive" : "active" };
}
