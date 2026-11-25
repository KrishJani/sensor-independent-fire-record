import { DurableObject } from "cloudflare:workers";
import { assignDetections, type ClusterStore, type IncidentRef } from "../cluster";
import { confidenceCode, type Detection } from "../detection";
import { bboxIntersects, type Bbox } from "../grid";
import { volcanoNear } from "../volcano";
import { compareIncidents } from "../status";
import { activityAt, INACTIVE_AFTER_MS, type IncidentStatus, type IncidentSummary } from "../incidentModel";
import { briefCacheKey, briefCachePrefix } from "../enrich/brief";
import { briefCacheFull, incidentsToPrune, LIVE_RETENTION_MS, pickCachedLevel, type PruneRow } from "../limits";
import type { Brief, MapPoint } from "../protocol";
import { briefMinAreaKm2, incidentId } from "../streams";
import type { IncidentIngestResult } from "./incident";

/** Dedupe ids are kept this long (stream time) before pruning. Live polls overlap by at most ~3 h. */
const DEDUPE_RETENTION_MS = LIVE_RETENTION_MS;
const INCIDENT_FANOUT = 24;
/** Max enrichment workflows started per ingest batch, so the largest queued incidents go first. */
const ENRICH_DISPATCH_PER_BATCH = 2;
/** Live: free slots are used up to this many per call (an hourly poll is one ingest), so the queue drains within the caps. */
const LIVE_DISPATCH_PER_BATCH = 10;
/** The live stream's ENRICH_MAX_PER_STREAM applies per rolling 24 h of wall clock. */
const LIVE_ENRICH_WINDOW_MS = 24 * 3600_000;
/** Live: how often (wall clock) quiet incidents are checked for a missing or out-of-date brief. */
const SWEEP_INTERVAL_MS = 30 * 60_000;
/** Incidents checked per sweep, largest first. */
const SWEEP_MAX = 40;
/** Incident DOs deleted per purgeStream() call (keeps each call well under the subrequest limit). */
const PURGE_CHUNK = 400;

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
      CREATE TABLE IF NOT EXISTS enrich_queue2 (
        incident_id TEXT PRIMARY KEY, reason TEXT NOT NULL, queued_t INTEGER NOT NULL, stable_key TEXT, level INTEGER NOT NULL DEFAULT 0
      );
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
    await this.sweepEnrichments(stream, streamT);
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

    if (streamT !== null && res.fresh.length > 0 && streamT - (Number(this.meta("prunedAt") ?? 0)) > 3600_000) {
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
        `INSERT INTO enrich_queue2 (incident_id, reason, queued_t, stable_key, level) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(incident_id) DO UPDATE SET
           reason = CASE WHEN enrich_queue2.reason = 'significant' THEN 'significant' ELSE excluded.reason END,
           level = CASE WHEN enrich_queue2.reason = 'significant' THEN enrich_queue2.level ELSE excluded.level END`,
        r.summary.id,
        r.enrich.reason,
        r.enrich.streamT,
        r.enrich.stableKey,
        r.enrich.level
      );
      this.bump("enrichments_queued", 1);
    }
  }

  /**
   * Live only, at most every SWEEP_INTERVAL_MS: asks the largest significant incidents last seen within 48 h whether a brief is missing (a failed attempt waiting out its backoff) or out of date (area +50 %).
   * Ingest only checks incidents that got new detections, so a quiet incident would otherwise keep a stale brief.
   * The caps are untouched: due incidents join the queue and dispatchEnrichments() applies them.
   */
  private async sweepEnrichments(stream: string, streamT: number | null) {
    if (stream !== "live" || streamT === null) return;
    const last = Number(this.meta("sweptAt") ?? 0);
    if (Date.now() - last < SWEEP_INTERVAL_MS) return;
    this.setMeta("sweptAt", String(Date.now()));
    const rows = this.sql
      .exec<{ id: string; summary: string }>("SELECT id, summary FROM incidents WHERE significant = 1 AND merged_into IS NULL AND summary IS NOT NULL")
      .toArray()
      .map((r) => JSON.parse(r.summary) as IncidentSummary)
      .filter((s) => !s.volcano && streamT - s.lastSeen <= INACTIVE_AFTER_MS)
      .sort((a, b) => compareIncidents(a, b, streamT))
      .slice(0, SWEEP_MAX);
    const minAreaKm2 = briefMinAreaKm2(this.env, stream);
    const due: IncidentIngestResult[] = [];
    for (let i = 0; i < rows.length; i += INCIDENT_FANOUT) {
      const out = await Promise.all(rows.slice(i, i + INCIDENT_FANOUT).map((s) => this.incidentStub(s.id).checkEnrichment({ streamT, minAreaKm2 })));
      for (const r of out) if (r?.enrich) due.push(r as unknown as IncidentIngestResult);
    }
    this.queueEnrichments(due);
    this.bump("enrich_sweeps", 1);
  }

  /** Briefs per cap window: ENRICH_MAX_LIVE for the live stream (rolling 24 h), ENRICH_MAX_PER_STREAM for a replay. */
  private streamCap(stream: string): number {
    return Number(stream === "live" ? (this.env.ENRICH_MAX_LIVE ?? this.env.ENRICH_MAX_PER_STREAM ?? 30) : (this.env.ENRICH_MAX_PER_STREAM ?? 30));
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
      .exec<{ incident_id: string; reason: string; stable_key: string | null; level: number; summary: string | null; merged_into: string | null }>(
        `SELECT q.incident_id, q.reason, q.stable_key, q.level, i.summary, i.merged_into FROM enrich_queue2 q JOIN incidents i ON i.id = q.incident_id`
      )
      .toArray();
    if (!queued.length) return;
    const rankT = streamT ?? Math.max(...queued.map((q) => (q.summary ? (JSON.parse(q.summary) as IncidentSummary).asOf : 0)));
    const ranked = queued
      .filter((q) => {
        if (q.merged_into || !q.summary) {
          this.sql.exec("DELETE FROM enrich_queue2 WHERE incident_id = ?", q.incident_id);
          return false;
        }
        return true;
      })
      .map((q) => ({ ...q, s: JSON.parse(q.summary!) as IncidentSummary }))
      .sort((a, b) => Number(a.reason !== "significant") - Number(b.reason !== "significant") || compareIncidents(a.s, b.s, rankT));

    const perStreamMax = this.streamCap(stream);
    const dailyMax = Number(this.env.BRIEF_DAILY_MAX ?? 60);
    for (const q of ranked.slice(0, stream === "live" ? LIVE_DISPATCH_PER_BATCH : ENRICH_DISPATCH_PER_BATCH)) {
      if (this.enrichmentsUsed(stream) >= perStreamMax) {
        this.bump("enrich_deferred_stream_cap", 1);
        return;
      }
      // Replays: reuse a brief from an earlier replay of the same scenario (no model call, no budget).
      const scenario = this.meta("scenario");
      const cacheKey = stream !== "live" && scenario && q.stable_key ? briefCacheKey(scenario, q.stable_key, q.level) : null;
      let cachedBrief: Brief | null = null;
      let skipBrief = false;
      if (cacheKey && scenario && q.stable_key) {
        try {
          cachedBrief = await this.env.REPLAY_KV.get<Brief>(cacheKey, "json");
          if (!cachedBrief) {
            // Tick timing and speed change which doubling levels a run reaches: reuse another level of this incident.
            const same = await this.env.REPLAY_KV.list({ prefix: briefCachePrefix(scenario, q.stable_key) });
            const level = pickCachedLevel(same.keys.map((k) => Number(k.name.split("/").pop())), q.level);
            if (level !== null) cachedBrief = await this.env.REPLAY_KV.get<Brief>(briefCacheKey(scenario, q.stable_key, level), "json");
          }
          if (!cachedBrief) {
            // Once the scenario's cache is full, replays make no new model calls.
            const all = await this.env.REPLAY_KV.list({ prefix: briefCachePrefix(scenario) });
            skipBrief = briefCacheFull(all.keys.length, perStreamMax);
          }
        } catch (err) {
          console.warn(JSON.stringify({ msg: "brief_cache_get_failed", key: cacheKey, error: String(err) }));
        }
        this.bump(cachedBrief ? "brief_cache_hits" : skipBrief ? "brief_cache_full_skips" : "brief_cache_misses", 1);
      }
      let grant: { used: number } = { used: -1 };
      if (!cachedBrief && !skipBrief) {
        const g = await this.control().tryConsumeBrief(dailyMax);
        if (!g.ok) {
          this.bump("enrich_deferred_daily_budget", 1);
          return;
        }
        grant = g;
      }
      this.sql.exec("DELETE FROM enrich_queue2 WHERE incident_id = ?", q.incident_id);
      this.sql.exec("INSERT INTO enrich_log (t, incident_id) VALUES (?, ?)", Date.now(), q.incident_id);
      this.bump("enrichments", 1);
      // Unique per attempt: a counter from enrich_log restarts when old rows are pruned and then collides with an
      // old instance ("already exists"), which used to burn the slot without running anything.
      const instanceId = `${q.incident_id.replace(/[^a-zA-Z0-9-]/g, "_")}-${Date.now().toString(36)}`;
      const at = Math.max(streamT ?? 0, q.s.asOf);
      try {
        await this.env.INCIDENT_ENRICH.create({
          id: instanceId,
          params: {
            incidentId: q.incident_id,
            stream,
            reason: q.reason === "significant" ? "significant" : "area_grown",
            streamT: at,
            summary: { ...q.s, asOf: at },
            ...(cachedBrief ? { cachedBrief } : skipBrief ? { skipBrief } : cacheKey ? { briefCacheKey: cacheKey } : {})
          }
        });
        console.log(JSON.stringify({ msg: "enrich_started", incident: q.incident_id, reason: q.reason, slotsUsed: this.enrichmentsUsed(stream), slotsMax: perStreamMax, affectedAreaKm2: q.s.affectedAreaKm2, cached: !!cachedBrief, skipBrief, briefsUsed24h: grant.used, queued: ranked.length }));
      } catch (err) {
        console.error(JSON.stringify({ msg: "enrich_start_failed", incident: q.incident_id, error: String(err) }));
        // Nothing ran: give the slot back and keep the incident queued for the next batch.
        this.sql.exec("DELETE FROM enrich_log WHERE rowid = (SELECT max(rowid) FROM enrich_log WHERE incident_id = ?)", q.incident_id);
        this.sql.exec(
          "INSERT OR IGNORE INTO enrich_queue2 (incident_id, reason, queued_t, stable_key, level) VALUES (?, ?, ?, ?, ?)",
          q.incident_id, q.reason, at, q.stable_key, q.level
        );
        this.bump("enrich_start_failures", 1);
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
    await this.sweepEnrichments(stream, t);
    await this.dispatchEnrichments(stream, t);
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
    const rankT = streamT ?? Math.max(0, ...out.map((s) => s.asOf));
    out.sort((a, b) => compareIncidents(a, b, rankT));
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
      queued: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM enrich_queue2").one().n,
      used: stream ? this.enrichmentsUsed(stream) : 0,
      max: stream ? this.streamCap(stream) : Number(this.env.ENRICH_MAX_PER_STREAM ?? 30),
      window: stream === "live" ? "24h" : "stream",
      // Which incidents used the slots (newest first), so a spent cap is explainable.
      usedBy: this.sql
        .exec<{ incident_id: string; t: number }>("SELECT incident_id, t FROM enrich_log WHERE t > ? ORDER BY t DESC LIMIT 60", stream === "live" ? Date.now() - LIVE_ENRICH_WINDOW_MS : 0)
        .toArray()
        .map((r) => ({ incident: r.incident_id, at: new Date(r.t).toISOString() }))
    };
    return { stream, streamT: this.streamT(), counters, incidents: inc, merges, enrich };
  }

  /**
   * Live only (called from the cron): deletes detections older than `cutoffT` and incidents with no
   * detection since then (with the incidents merged into them), including their cells, Incident DOs
   * and LiveHub rows. The enrich log keeps 24 h (the ENRICH_MAX_PER_STREAM window).
   */
  async prune(cutoffT: number): Promise<{ detections: number; incidents: number }> {
    if (this.meta("stream") !== "live") return { detections: 0, incidents: 0 };
    const detections = this.sql.exec("DELETE FROM detections WHERE t < ?", cutoffT).rowsWritten;
    const rows: PruneRow[] = this.sql.exec<{ id: string; last_t: number; merged_into: string | null }>("SELECT id, last_t, merged_into FROM incidents").toArray();
    const ids = [...incidentsToPrune(rows, cutoffT)];
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) {
        this.sql.exec("DELETE FROM cells WHERE incident_id = ?", id);
        this.sql.exec("DELETE FROM enrich_queue2 WHERE incident_id = ?", id);
        this.sql.exec("DELETE FROM incidents WHERE id = ?", id);
      }
      this.sql.exec("DELETE FROM merges WHERE t < ?", cutoffT);
      this.sql.exec("DELETE FROM enrich_log WHERE t < ?", Date.now() - LIVE_ENRICH_WINDOW_MS);
    });
    await this.purgeIncidents(ids);
    if (ids.length) await this.hub("live").forget(ids);
    return { detections, incidents: ids.length };
  }

  /**
   * Replays: deletes up to PURGE_CHUNK Incident DOs of this stream per call; once none are left,
   * deletes this DO's storage. Returns how many incidents remain (call again until 0).
   */
  async purgeStream(): Promise<number> {
    const ids = this.sql.exec<{ id: string }>("SELECT id FROM incidents LIMIT ?", PURGE_CHUNK).toArray().map((r) => r.id);
    await this.purgeIncidents(ids);
    for (const id of ids) this.sql.exec("DELETE FROM incidents WHERE id = ?", id);
    const left = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM incidents").one().n;
    if (left === 0) await this.ctx.storage.deleteAll();
    return left;
  }

  private async purgeIncidents(ids: string[]) {
    for (let i = 0; i < ids.length; i += INCIDENT_FANOUT) {
      await Promise.all(ids.slice(i, i + INCIDENT_FANOUT).map((id) => this.incidentStub(id).purge()));
    }
  }

  /** Replay DO: records the scenario id (brief cache key). */
  async setScenario(scenario: string): Promise<void> {
    this.setMeta("scenario", scenario);
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
  if (s.status === "merged" || streamT === null) return { ...s, volcano: s.volcano ?? volcanoNear(s.centroid[0], s.centroid[1]) };
  // Summaries stored before these fields existed get them here.
  return { ...s, volcano: s.volcano ?? volcanoNear(s.centroid[0], s.centroid[1]), activity: activityAt(s.lastSeen, streamT), status: streamT - s.lastSeen > INACTIVE_AFTER_MS ? "inactive" : "active" };
}
