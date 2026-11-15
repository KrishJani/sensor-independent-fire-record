import { DurableObject } from "cloudflare:workers";
import { parseBbox, type Bbox } from "../grid";
import type { IncidentSummary } from "../incidentModel";
import type { Brief, ClientMessage, MapPoint, PublishPayload, ServerMessage } from "../protocol";

/** Minimum gap between flushes to one socket (coalescing window). */
const FLUSH_INTERVAL_MS = 400;
/** Points kept for late joiners / viewport changes (stream time). */
const POINT_RETENTION_MS = 48 * 3600_000;
const MAX_POINTS_PER_MESSAGE = 5000;

interface Attachment {
  bbox: Bbox | null;
}

/**
 * One per stream. Hibernatable WebSockets (ctx.acceptWebSocket). Publishers call publish();
 * updates are coalesced in memory and flushed to every socket at most every FLUSH_INTERVAL_MS:
 * per flush a client gets at most one clock, one detections message, and one upsert per changed
 * incident (latest version only).
 */
export class LiveHub extends DurableObject<Env> {
  private sql: SqlStorage;
  private pendingUpserts = new Map<string, IncidentSummary>();
  private pendingBriefs = new Map<string, Brief>();
  private pendingPoints: MapPoint[] = [];
  private pendingClock: number | null = null;
  private pendingReplay: { status: string; progress: number } | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlush = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, summary TEXT NOT NULL, brief TEXT);
      CREATE TABLE IF NOT EXISTS points (t INTEGER NOT NULL, lon REAL NOT NULL, lat REAL NOT NULL, frp REAL NOT NULL, conf INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS points_t ON points (t);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const stream = url.searchParams.get("stream") ?? "live";
    if (!this.meta("stream")) this.setMeta("stream", stream);
    const bbox = parseBbox(url.searchParams.get("bbox"));

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ bbox } satisfies Attachment);

    // Initial snapshot: hello, current clock, every known significant incident (+ briefs), recent points.
    const incidents = this.sql.exec<{ summary: string; brief: string | null }>("SELECT summary, brief FROM incidents").toArray();
    const streamT = this.streamT();
    this.send(server, { type: "hello", stream, streamT, incidents: incidents.length });
    if (streamT !== null && stream !== "live") this.send(server, { type: "clock", t: streamT });
    for (const r of incidents) {
      const incident = JSON.parse(r.summary) as IncidentSummary;
      this.send(server, { type: "incident.upsert", incident });
      if (r.brief) this.send(server, { type: "incident.brief", id: incident.id, brief: JSON.parse(r.brief) });
    }
    this.send(server, { type: "detections", points: this.recentPoints(bbox), replace: true });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      return this.send(ws, { type: "error", message: "invalid JSON" });
    }
    if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
    if (msg.type === "viewport") {
      const raw = msg.bbox;
      const bbox = Array.isArray(raw) ? parseBbox(raw.join(",")) : null;
      if (raw && !bbox) return this.send(ws, { type: "error", message: "bbox must be [west, south, east, north]" });
      ws.serializeAttachment({ bbox } satisfies Attachment);
      this.send(ws, { type: "detections", points: this.recentPoints(bbox), replace: true });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "error");
    } catch {
      /* ignore */
    }
  }

  /** Called by Clusterer (upserts, points), Replay (clock, status) and the enrichment Workflow (briefs). */
  async publish(p: PublishPayload): Promise<void> {
    for (const s of p.upserts ?? []) {
      this.pendingUpserts.set(s.id, s);
      this.sql.exec(
        "INSERT INTO incidents (id, summary) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET summary = excluded.summary",
        s.id,
        JSON.stringify(s)
      );
    }
    for (const b of p.briefs ?? []) {
      this.pendingBriefs.set(b.id, b.brief);
      this.sql.exec("UPDATE incidents SET brief = ? WHERE id = ?", JSON.stringify(b.brief), b.id);
    }
    if (p.points?.length) {
      for (const [lon, lat, frp, t, conf] of p.points) {
        this.sql.exec("INSERT INTO points (t, lon, lat, frp, conf) VALUES (?, ?, ?, ?, ?)", t, lon, lat, frp, conf);
      }
      this.pendingPoints.push(...p.points);
      const maxT = Math.max(...p.points.map((x) => x[3]));
      if (maxT > (this.streamT() ?? 0)) this.setMeta("streamT", String(maxT));
      this.sql.exec("DELETE FROM points WHERE t < ?", (this.streamT() ?? maxT) - POINT_RETENTION_MS);
    }
    if (p.clock !== undefined) {
      this.pendingClock = p.clock;
      if (p.clock > (this.streamT() ?? 0)) this.setMeta("streamT", String(p.clock));
    }
    if (p.replayStatus) this.pendingReplay = p.replayStatus;
    this.scheduleFlush();
  }

  async stats() {
    return {
      sockets: this.ctx.getWebSockets().length,
      incidents: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM incidents").one().n,
      points: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM points").one().n,
      streamT: this.streamT()
    };
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    const wait = Math.max(0, this.lastFlush + FLUSH_INTERVAL_MS - Date.now());
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  private flush() {
    this.flushTimer = null;
    this.lastFlush = Date.now();
    const upserts = [...this.pendingUpserts.values()];
    const briefs = [...this.pendingBriefs.entries()];
    const points = this.pendingPoints;
    const clock = this.pendingClock;
    const replay = this.pendingReplay;
    this.pendingUpserts.clear();
    this.pendingBriefs.clear();
    this.pendingPoints = [];
    this.pendingClock = null;
    this.pendingReplay = null;

    for (const ws of this.ctx.getWebSockets()) {
      const att = (ws.deserializeAttachment() as Attachment | null) ?? { bbox: null };
      if (clock !== null) this.send(ws, { type: "clock", t: clock });
      for (const incident of upserts) this.send(ws, { type: "incident.upsert", incident });
      for (const [id, brief] of briefs) this.send(ws, { type: "incident.brief", id, brief });
      if (points.length) {
        const visible = att.bbox ? points.filter((p) => inside(p, att.bbox!)) : points;
        if (visible.length) this.send(ws, { type: "detections", points: visible.slice(-MAX_POINTS_PER_MESSAGE) });
      }
      if (replay) this.send(ws, { type: "replay.status", ...replay });
    }
  }

  private recentPoints(bbox: Bbox | null): MapPoint[] {
    const where = bbox ? "WHERE lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?" : "";
    const args = bbox ? [bbox[0], bbox[2], bbox[1], bbox[3]] : [];
    return this.sql
      .exec<{ t: number; lon: number; lat: number; frp: number; conf: number }>(
        `SELECT t, lon, lat, frp, conf FROM points ${where} ORDER BY t DESC LIMIT ${MAX_POINTS_PER_MESSAGE}`,
        ...args
      )
      .toArray()
      .reverse()
      .map((r) => [r.lon, r.lat, r.frp, r.t, r.conf] as MapPoint);
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
  }

  private meta(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }
  private setMeta(k: string, v: string) {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }
  private streamT(): number | null {
    const v = this.meta("streamT");
    return v === null ? null : Number(v);
  }
}

function inside(p: MapPoint, b: Bbox): boolean {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}
