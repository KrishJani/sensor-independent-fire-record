import { DurableObject } from "cloudflare:workers";
import type { Detection } from "../detection";
import {
  applyDetections,
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
  /** Set when enrichment is due (first significant, or area doubled ≥ 6 h of stream time later). */
  enrich: { reason: "significant" | "area_doubled"; streamT: number } | null;
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

  async ingest(args: { id: string; stream: string; detections: Detection[]; streamT: number }): Promise<IncidentIngestResult> {
    const s = (this.state ??= emptyState(args.id, args.stream));
    applyDetections(s, args.detections, args.streamT);
    // The Clusterer starts the INCIDENT_ENRICH workflow (it owns the per-stream budget).
    const due = enrichmentDue(s, s.streamT);
    if (due) s.enrichments.push(due);
    this.put("state", s);
    return { summary: summarize(s), enrich: due ? { reason: due.reason, streamT: due.t } : null };
  }

  async markMerged(into: string, _t: number): Promise<void> {
    if (!this.state) return;
    this.state.mergedInto = into;
    this.put("state", this.state);
  }

  async detail(streamT?: number | null): Promise<IncidentDetail | null> {
    if (!this.state) return null;
    const enrichment = this.get("enrichment");
    const brief = this.get("brief");
    return {
      summary: summarize(this.state, Math.max(this.state.streamT, streamT ?? 0)),
      timeline: timeline(this.state),
      enrichments: this.state.enrichments,
      enrichment: enrichment ? JSON.parse(enrichment) : null,
      brief: brief ? (JSON.parse(brief) as Brief) : null
    };
  }

  async summary(): Promise<IncidentSummary | null> {
    return this.state ? summarize(this.state) : null;
  }

  async setEnrichment(enrichment: unknown, brief: Brief | null): Promise<void> {
    this.put("enrichment", enrichment);
    if (brief) this.put("brief", brief);
  }
}
