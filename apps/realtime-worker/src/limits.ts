/** Demo limits and storage retention (pure; unit-tested). */

/** Starting a new replay (joining the running one is not limited) at most once per this window, globally. */
export const REPLAY_START_COOLDOWN_MS = 30_000;

/** Milliseconds left before another replay may start; 0 when it may start now. */
export function cooldownLeftMs(lastStartAt: number | null, now: number, cooldownMs = REPLAY_START_COOLDOWN_MS): number {
  return lastStartAt === null ? 0 : Math.max(0, lastStartAt + cooldownMs - now);
}

/** Live detections and quiet live incidents are deleted after this long (matches the 48 h link window). */
export const LIVE_RETENTION_MS = 48 * 3600_000;

/** A finished or stopped replay's storage (Replay, Clusterer, Incident and LiveHub DOs) is deleted after this long. */
export const REPLAY_PURGE_AFTER_MS = 3600_000;

/**
 * Replay brief cache: which cached level to reuse for an incident whose exact level is not cached.
 * Tick timing and speed change which area-doubling levels a run reaches, so the same incident can
 * ask for a level the first run never briefed. Prefers the highest cached level at or below the
 * requested one, else the lowest cached level. null when nothing is cached for the incident.
 */
export function pickCachedLevel(cached: number[], level: number): number | null {
  const ok = cached.filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
  if (!ok.length) return null;
  const below = ok.filter((n) => n <= level);
  return below.length ? below[below.length - 1] : ok[0];
}

/**
 * A scenario's brief cache is full once it holds `max` briefs (ENRICH_MAX_PER_STREAM, the most one
 * replay can request). After that, replays make no new model calls: an incident with no cached
 * brief is enriched without one.
 */
export function briefCacheFull(cachedCount: number, max: number): boolean {
  return cachedCount >= max;
}

export interface PruneRow {
  id: string;
  last_t: number;
  merged_into: string | null;
}

/**
 * Incidents to delete: surviving incidents with no detection since `cutoff`, plus every incident
 * merged (directly or through a chain) into one of them. Incidents merged into a survivor that is
 * still active are kept, so cell lookups that follow merge links never hit a missing row.
 */
export function incidentsToPrune(rows: PruneRow[], cutoff: number): Set<string> {
  const out = new Set(rows.filter((r) => r.merged_into === null && r.last_t < cutoff).map((r) => r.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.merged_into !== null && !out.has(r.id) && out.has(r.merged_into)) {
        out.add(r.id);
        grew = true;
      }
    }
  }
  return out;
}
