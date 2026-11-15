import { DurableObject } from "cloudflare:workers";
import type { ReplayInfo } from "./replay";

/** Wall-clock window for the global brief budget. */
export const BRIEF_WINDOW_MS = 24 * 3600_000;
/** A paused replay holds the replay slot for at most this long (wall clock since it was created). */
export const PAUSED_REPLAY_TTL_MS = 30 * 60_000;
/** A claimed slot whose Replay has not reported a status yet counts as starting for this long. */
const STARTING_GRACE_MS = 60_000;

export type ReplayClaim =
  | { action: "start"; id: string }
  | { action: "existing"; id: string; info: ReplayInfo | null }
  | { action: "busy"; id: string; scenario: string };

export interface BriefGrant {
  ok: boolean;
  used: number;
  max: number;
}

/**
 * Global singleton (DO name "global"): the one replay slot and the daily AI brief budget,
 * shared by every stream. Kept separate from the per-stream Clusterers so the limits hold
 * across all of them.
 */
export class Control extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS replay_slot (k INTEGER PRIMARY KEY CHECK (k = 1), id TEXT NOT NULL, scenario TEXT NOT NULL, claimed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS brief_log (t INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS brief_log_t ON brief_log (t);
    `);
  }

  private slot(): { id: string; scenario: string; claimed_at: number } | null {
    return this.sql.exec<{ id: string; scenario: string; claimed_at: number }>("SELECT id, scenario, claimed_at FROM replay_slot WHERE k = 1").toArray()[0] ?? null;
  }
  private setSlot(id: string, scenario: string) {
    this.sql.exec(
      "INSERT INTO replay_slot (k, id, scenario, claimed_at) VALUES (1, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET id = excluded.id, scenario = excluded.scenario, claimed_at = excluded.claimed_at",
      id,
      scenario,
      Date.now()
    );
  }

  /**
   * At most one active replay overall. Same scenario already running → "existing" (reuse it);
   * a different scenario running → "busy"; otherwise the slot is claimed for `id` → "start".
   */
  async claimReplay(args: { id: string; scenario: string }): Promise<ReplayClaim> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = this.slot();
      if (!cur) {
        this.setSlot(args.id, args.scenario);
        return { action: "start", id: args.id };
      }
      const stub = this.env.REPLAY.get(this.env.REPLAY.idFromName(cur.id));
      let info = (await stub.status()) as ReplayInfo | null;
      // Another claim may have run while we awaited; re-check against the slot we inspected.
      if (this.slot()?.id !== cur.id) continue;

      const starting = !info && Date.now() - cur.claimed_at < STARTING_GRACE_MS;
      if (info?.status === "paused" && Date.now() - info.createdAt > PAUSED_REPLAY_TTL_MS) {
        info = (await stub.stop()) as ReplayInfo | null; // abandoned: free the slot
        if (this.slot()?.id !== cur.id) continue;
      }
      const active = starting || info?.status === "running" || info?.status === "paused";
      if (active) {
        return cur.scenario === args.scenario
          ? { action: "existing", id: cur.id, info }
          : { action: "busy", id: cur.id, scenario: cur.scenario };
      }
      this.setSlot(args.id, args.scenario);
      return { action: "start", id: args.id };
    }
    throw new Error("replay slot is contended; retry");
  }

  /** Called when a replay ends (done, stopped, error) or failed to start. */
  async releaseReplay(id: string): Promise<void> {
    this.sql.exec("DELETE FROM replay_slot WHERE k = 1 AND id = ?", id);
  }

  async activeReplay(): Promise<{ id: string; scenario: string } | null> {
    const s = this.slot();
    return s ? { id: s.id, scenario: s.scenario } : null;
  }

  /** Takes one brief from the global budget (rolling 24 h of wall clock) if any is left. */
  async tryConsumeBrief(max: number): Promise<BriefGrant> {
    const now = Date.now();
    this.sql.exec("DELETE FROM brief_log WHERE t <= ?", now - BRIEF_WINDOW_MS);
    const used = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM brief_log").one().n;
    if (used >= max) return { ok: false, used, max };
    this.sql.exec("INSERT INTO brief_log (t) VALUES (?)", now);
    return { ok: true, used: used + 1, max };
  }

  async briefBudget(max: number): Promise<{ used: number; max: number; windowHours: number }> {
    const used = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM brief_log WHERE t > ?", Date.now() - BRIEF_WINDOW_MS).one().n;
    return { used, max, windowHours: BRIEF_WINDOW_MS / 3600_000 };
  }
}
