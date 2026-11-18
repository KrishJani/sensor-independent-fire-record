import { DurableObject } from "cloudflare:workers";
import { fromCompact, withStream, type CompactRow, type Detection } from "../detection";
import { REPLAY_PURGE_AFTER_MS } from "../limits";
import { loadScenario, type ScenarioOrigin } from "../replay/scenarios";
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
  origin: ScenarioOrigin;
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

/** Allowed replay speeds, stream seconds per real second (the API validates against this). */
export const MAX_SPEED = 1_000_000;

/**
 * One per replay. Copies the scenario into its SQLite on start, then an alarm loop advances stream
 * time by speed × real elapsed time and feeds every detection up to that time into the stream's
 * Clusterer, in time order. REPLAY_PURGE_AFTER_MS after it ends, the replay deletes its own storage
 * and its stream's Clusterer, Incident and LiveHub storage.
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
    await this.env.CLUSTERER.get(this.env.CLUSTERER.idFromName(info.stream)).setScenario(info.scenario);
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
    await this.hub(info.stream).publish({ replayStatus: this.statusMsg(info) });
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

  /** Changes the speed of a running or paused replay; the clock continues from where it is. */
  async setSpeed(speed: number): Promise<ReplayInfo | null> {
    const info = this.info();
    if (info?.status !== "running" && info?.status !== "paused") return info;
    info.speed = speed;
    info.expectedDurationS = Math.round((info.endT - info.startT) / speed / 1000);
    this.save(info);
    await this.hub(info.stream).publish({ replayStatus: this.statusMsg(info) });
    return info;
  }

  async stop(): Promise<ReplayInfo | null> {
    const info = this.info();
    if (!info || info.status === "done" || info.status === "stopped") return info;
    info.status = "stopped";
    info.finishedAt = Date.now();
    this.save(info);
    await this.ctx.storage.setAlarm(info.finishedAt + REPLAY_PURGE_AFTER_MS);
    await this.releaseSlot(info.id);
    await this.hub(info.stream).publish({ replayStatus: this.statusMsg(info) });
    return info;
  }

  async alarm(): Promise<void> {
    const info = this.info();
    if (!info) return;
    if (info.status === "done" || info.status === "stopped" || info.status === "error") return this.purgeIfDue(info);
    if (info.status !== "running") return;
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

      // pause/stop/setSpeed can run while this tick awaits the Clusterer: keep what they changed.
      const latest = this.info();
      if (latest) {
        info.speed = latest.speed;
        info.expectedDurationS = latest.expectedDurationS;
        if (latest.status !== "running") {
          info.status = latest.status;
          info.finishedAt = latest.finishedAt;
        }
      }
      const finished = info.status === "running" && info.emitted >= info.total && info.streamT >= info.endT;
      if (finished) {
        info.status = "done";
        info.finishedAt = now;
      }
      this.save(info);
      await this.hub(info.stream).publish({ clock: info.streamT, replayStatus: this.statusMsg(info) });
      if (finished) {
        await this.releaseSlot(info.id);
        await this.ctx.storage.setAlarm(now + REPLAY_PURGE_AFTER_MS);
      } else if (info.status === "running") await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    } catch (err) {
      console.error(JSON.stringify({ msg: "replay_tick_failed", id: info.id, error: String(err) }));
      // Keep going: retry this window on the next tick instead of burning the alarm's retry budget.
      if (this.info()?.status === "running") await this.ctx.storage.setAlarm(Date.now() + TICK_MS * 2);
    }
  }

  /**
   * Deletes this replay's stream (Clusterer, its Incident DOs, LiveHub) and then this DO's own
   * storage. Runs from the alarm REPLAY_PURGE_AFTER_MS after the replay ended.
   */
  private async purgeIfDue(info: ReplayInfo) {
    const due = (info.finishedAt ?? info.createdAt) + REPLAY_PURGE_AFTER_MS;
    if (Date.now() < due) {
      await this.ctx.storage.setAlarm(due);
      return;
    }
    const clusterer = this.env.CLUSTERER.get(this.env.CLUSTERER.idFromName(info.stream));
    for (let left = 1, calls = 0; left > 0 && calls < 50; calls++) left = await clusterer.purgeStream();
    await this.hub(info.stream).purge();
    await this.ctx.storage.deleteAll();
    console.log(JSON.stringify({ msg: "replay_purged", id: info.id, stream: info.stream }));
  }

  private statusMsg(info: ReplayInfo) {
    return { status: info.status, progress: info.progress, speed: info.speed };
  }

  /** Frees the global one-active-replay slot (see Control). */
  private async releaseSlot(id: string) {
    try {
      await this.env.CONTROL.get(this.env.CONTROL.idFromName("global")).releaseReplay(id);
    } catch (err) {
      console.warn(JSON.stringify({ msg: "replay_release_failed", id, error: String(err) }));
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
