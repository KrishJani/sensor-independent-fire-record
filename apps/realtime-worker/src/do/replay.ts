import { DurableObject } from "cloudflare:workers";
import { fromCompact, withStream, type CompactRow, type Detection } from "../detection";
import { loadScenario } from "../replay/scenarios";
import { replayStream } from "../streams";

/** Real-time interval between replay ticks. */
const TICK_MS = 500;
/** Max detections pushed into the Clusterer per tick; the rest follow on the next tick. */
const MAX_PER_TICK = 2500;

export type ReplayStatus = "running" | "paused" | "stopped" | "done" | "error";

export interface ReplayInfo {
  id: string;
  stream: string;
  scenario: string;
  origin: "r2" | "bundled";
  note: string | null;
  speed: number;
  status: ReplayStatus;
  startT: number;
  endT: number;
  streamT: number;
  total: number;
  emitted: number;
  progress: number; // 0..1 of stream time
  createdAt: number;
  finishedAt: number | null;
  /** Expected real duration at this speed, seconds. */
  expectedDurationS: number;
  error: string | null;
}

/**
 * One per replay. Copies the scenario into its SQLite on start, then an alarm loop advances stream
 * time by speed × real elapsed time and feeds every detection up to that time into the stream's
 * Clusterer, in time order.
 */
export class Replay extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS info (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rows (i INTEGER PRIMARY KEY, t INTEGER NOT NULL, r TEXT NOT NULL);
    `);
  }

  private info(): ReplayInfo | null {
    const v = this.sql.exec<{ v: string }>("SELECT v FROM info WHERE k = 'info'").toArray()[0]?.v;
    return v ? (JSON.parse(v) as ReplayInfo) : null;
  }
  private save(info: ReplayInfo) {
    info.progress = info.endT > info.startT ? Math.min(1, (info.streamT - info.startT) / (info.endT - info.startT)) : 1;
    this.sql.exec(
      "INSERT INTO info (k, v) VALUES ('info', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      JSON.stringify(info)
    );
  }

  async start(args: { id: string; scenario: string; speed: number }): Promise<ReplayInfo> {
    const existing = this.info();
    if (existing) return existing;
    const { scenario, origin, note } = await loadScenario(this.env, args.scenario);
    const rows = scenario.rows;
    if (rows.length === 0) throw new Error(`scenario ${scenario.scenario} has no rows`);

    this.ctx.storage.transactionSync(() => {
      rows.forEach((r, i) => this.sql.exec("INSERT INTO rows (i, t, r) VALUES (?, ?, ?)", i, r[0], JSON.stringify(r)));
    });
    const startT = rows[0][0] - 3600_000;
    const endT = rows[rows.length - 1][0];
    const info: ReplayInfo = {
      id: args.id,
      stream: replayStream(args.id),
      scenario: scenario.scenario,
      origin,
      note: note ?? null,
      speed: args.speed,
      status: "running",
      startT,
      endT,
      streamT: startT,
      total: rows.length,
      emitted: 0,
      progress: 0,
      createdAt: Date.now(),
      finishedAt: null,
      expectedDurationS: Math.round((endT - startT) / args.speed / 1000),
      error: null
    };
    this.save(info);
    this.setMeta("lastTick", Date.now());
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return info;
  }

  async status(): Promise<ReplayInfo | null> {
    return this.info();
  }

  async pause(): Promise<ReplayInfo | null> {
    const info = this.info();
    if (info?.status !== "running") return info;
    info.status = "paused";
    this.save(info);
    await this.ctx.storage.deleteAlarm();
    await this.hub(info.stream).publish({ replayStatus: { status: info.status, progress: info.progress } });
    return info;
  }

  async resume(): Promise<ReplayInfo | null> {
    const info = this.info();
    if (info?.status !== "paused") return info;
    info.status = "running";
    this.save(info);
    this.setMeta("lastTick", Date.now());
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return info;
  }

  async stop(): Promise<ReplayInfo | null> {
    const info = this.info();
    if (!info || info.status === "done" || info.status === "stopped") return info;
    info.status = "stopped";
    info.finishedAt = Date.now();
    this.save(info);
    await this.ctx.storage.deleteAlarm();
    await this.hub(info.stream).publish({ replayStatus: { status: info.status, progress: info.progress } });
    return info;
  }

  async alarm(): Promise<void> {
    const info = this.info();
    if (!info || info.status !== "running") return;
    const now = Date.now();
    const lastTick = Number(this.getMeta("lastTick") ?? now);
    this.setMeta("lastTick", now);
    try {
      const target = Math.min(info.endT, info.streamT + Math.max(0, now - lastTick) * info.speed);
      const rows = this.sql
        .exec<{ r: string }>("SELECT r FROM rows WHERE i >= ? AND t <= ? ORDER BY i LIMIT ?", info.emitted, target, MAX_PER_TICK)
        .toArray()
        .map((x) => JSON.parse(x.r) as CompactRow);
      const detections: Detection[] = rows.map((r) => withStream(fromCompact(r), info.stream));
      // If the per-tick cap was hit, only advance the clock to the last emitted detection.
      const caughtUp = rows.length < MAX_PER_TICK;
      info.streamT = caughtUp ? target : Math.max(info.streamT, rows[rows.length - 1][0]);
      info.emitted += rows.length;

      const clusterer = this.env.CLUSTERER.get(this.env.CLUSTERER.idFromName(info.stream));
      if (detections.length) await clusterer.ingest(info.stream, detections);
      await clusterer.advanceClock(info.stream, info.streamT);

      const finished = info.emitted >= info.total && info.streamT >= info.endT;
      if (finished) {
        info.status = "done";
        info.finishedAt = now;
      }
      this.save(info);
      await this.hub(info.stream).publish({
        clock: info.streamT,
        replayStatus: { status: info.status, progress: info.progress }
      });
      if (!finished) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    } catch (err) {
      console.error(JSON.stringify({ msg: "replay_tick_failed", id: info.id, error: String(err) }));
      // Keep going: retry this window on the next tick instead of burning the alarm's retry budget.
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS * 2);
    }
  }

  private hub(stream: string) {
    return this.env.LIVE_HUB.get(this.env.LIVE_HUB.idFromName(stream));
  }
  private getMeta(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM info WHERE k = ?", `m:${k}`).toArray()[0]?.v ?? null;
  }
  private setMeta(k: string, v: number | string) {
    this.sql.exec("INSERT INTO info (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", `m:${k}`, String(v));
  }
}
