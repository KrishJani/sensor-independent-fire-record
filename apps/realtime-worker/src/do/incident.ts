import { DurableObject } from "cloudflare:workers";
import type { Detection } from "../detection";
import {
  applyDetections,
  areaAt,
  emptyState,
  enrichmentDue,
  summarize,
  timeline,
  type IncidentState,
  type IncidentSummary,
  type TimelinePoint
} from "../incidentModel";
import type { Brief } from "../protocol";

export interface IncidentIngestResult {
  summary: IncidentSummary;
  /**
   * Set when enrichment is due (see enrichmentDue: no brief yet, or the area grew ≥ 50 % since the last
   * brief; failed attempts back off). The Clusterer queues it; the attempt is recorded at once so it is not re-queued.
   */
  enrich: {
    reason: "significant" | "area_grown";
    streamT: number;
    /** firstDetectionId: identifies "the same incident" across replays of a scenario (brief cache). */
    stableKey: string | null;
    /** n-th enrichment attempt (0 = the first). */
    level: number;
  } | null;
}

export interface IncidentDetail {
  summary: IncidentSummary;
  timeline: TimelinePoint[];
  enrichment: unknown | null;
  enrichments: IncidentState["enrichments"];
  brief: Brief | null;
}

/** One per incident (DO name = incident id). Holds the aggregate, timeline, enrichment and brief. */
export class Incident extends DurableObject<Env> {
  private sql: SqlStorage;
  private state: IncidentState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    const raw = this.get("state");
    if (raw) this.state = JSON.parse(raw) as IncidentState;
  }

  private get(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = ?", k).toArray()[0]?.v ?? null;
  }
  private put(k: string, v: unknown) {
    this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
  }

  async ingest(args: { id: string; stream: string; detections: Detection[]; streamT: number; minAreaKm2?: number }): Promise<IncidentIngestResult> {
    const s = (this.state ??= emptyState(args.id, args.stream));
    applyDetections(s, args.detections, args.streamT);
    // The Clusterer queues and starts INCIDENT_ENRICH (it owns the priority order and the budgets).
    const due = this.markDue(s, args.minAreaKm2 ?? 0);
    this.put("state", s);
    return { summary: summarize(s), enrich: this.enrichInfo(s, due) };
  }

  /** Sweep: is a (re-)brief due for an incident that got no new detections? Records the attempt like ingest does. */
  async checkEnrichment(args: { streamT: number; minAreaKm2?: number }): Promise<IncidentIngestResult | null> {
    const s = this.state;
    if (!s) return null;
    s.streamT = Math.max(s.streamT, args.streamT);
    const due = this.markDue(s, args.minAreaKm2 ?? 0);
    if (due) this.put("state", s);
    return { summary: summarize(s), enrich: this.enrichInfo(s, due) };
  }

  private markDue(s: IncidentState, minAreaKm2: number) {
    this.recoverBriefMark(s);
    const due = enrichmentDue(s, s.streamT, minAreaKm2);
    if (due) s.enrichments.push(due);
    return due;
  }

  private enrichInfo(s: IncidentState, due: ReturnType<typeof enrichmentDue>): IncidentIngestResult["enrich"] {
    return due ? { reason: due.reason === "area_doubled" ? "area_grown" : due.reason, streamT: due.t, stableKey: s.firstDetectionId ?? null, level: s.enrichments.length - 1 } : null;
  }

  /** Briefs written before briefOk existed: derive "which area did it describe" from the stored brief and the timeline. */
  private recoverBriefMark(s: IncidentState) {
    if (s.briefOk !== undefined) return;
    const raw = this.get("brief");
    if (!raw) {
      s.briefOk = null;
      return;
    }
    const b = JSON.parse(raw) as Brief;
    const area = b.affectedAreaKm2 ?? areaAt(timeline(s), b.streamT);
    s.briefOk = area ? { t: b.streamT, affectedAreaKm2: area } : null;
  }

  async markMerged(into: string, _t: number): Promise<void> {
    if (!this.state) return;
    this.state.mergedInto = into;
    this.put("state", this.state);
  }

  async detail(streamT?: number | null): Promise<IncidentDetail | null> {
    if (!this.state) return null;
    const enrichment = this.get("enrichment");
    const raw = this.get("brief");
    const tl = timeline(this.state);
    let brief: Brief | null = raw ? (JSON.parse(raw) as Brief) : null;
    // Briefs written before they recorded their area: recover it so the card can tell whether they are out of date.
    if (brief && brief.affectedAreaKm2 === undefined) {
      const area = areaAt(tl, brief.streamT);
      if (area) brief = { ...brief, affectedAreaKm2: area };
    }
    return {
      summary: summarize(this.state, Math.max(this.state.streamT, streamT ?? 0)),
      timeline: tl,
      enrichments: this.state.enrichments,
      enrichment: enrichment ? JSON.parse(enrichment) : null,
      brief
    };
  }

  /** Deletes this incident's storage (live pruning, replay purge). */
  async purge(): Promise<void> {
    this.state = null;
    await this.ctx.storage.deleteAll();
  }

  async summary(): Promise<IncidentSummary | null> {
    return this.state ? summarize(this.state) : null;
  }

  /**
   * Stores the enrichment. `attempt` is what the workflow tried to brief: a generated brief becomes the
   * reference for "is it out of date" (briefOk); a failed one counts toward the retry backoff.
   */
  async setEnrichment(enrichment: unknown, brief: Brief | null, attempt?: { streamT: number; affectedAreaKm2: number; failed: boolean }): Promise<void> {
    this.put("enrichment", enrichment);
    if (brief) this.put("brief", brief);
    const s = this.state;
    if (!s || !attempt) return;
    if (brief) {
      s.briefOk = { t: brief.streamT, affectedAreaKm2: brief.affectedAreaKm2 ?? attempt.affectedAreaKm2 };
      s.briefFails = 0;
    } else if (attempt.failed) {
      s.briefFails = (s.briefFails ?? 0) + 1;
    }
    this.put("state", s);
  }
}
