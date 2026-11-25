/**
 * Incident activity and brief-staleness rules. Pure and dependency-free: the web app imports this file too,
 * so the list, the card and the worker's re-brief logic share one definition.
 */

/** Clustering/retention rule: an incident quiet this long is `status: "inactive"` (and a new detection nearby starts a new one). */
export const INACTIVE_AFTER_MS = 48 * 3600_000;
/** What the UI shows (stream clock, time since the last detection): active < 12 h, cooling 12–36 h, inactive after. */
export const ACTIVE_UNTIL_MS = 12 * 3600_000;
export const COOLING_UNTIL_MS = 36 * 3600_000;

export type Activity = "active" | "cooling" | "inactive";

/** Activity of an incident last seen at `lastT`, at stream time `streamT` (epoch ms). */
export function activityAt(lastT: number, streamT: number): Activity {
  const quiet = streamT - lastT;
  return quiet < ACTIVE_UNTIL_MS ? "active" : quiet <= COOLING_UNTIL_MS ? "cooling" : "inactive";
}

/** A brief is re-written once the area has grown this much since the brief (≥ 6 h after the last attempt). */
export const REBRIEF_AREA_RATIO = 1.5;
/** The card labels a brief "out of date" at this growth. */
export const STALE_AREA_RATIO = 1.25;

/** How a brief compares with the incident now. `areaAtBrief` unknown/0 = never stale (nothing to compare). */
export function briefStaleness(areaAtBrief: number | null | undefined, areaNow: number): { stale: boolean; growth: number | null } {
  if (!areaAtBrief || areaAtBrief <= 0) return { stale: false, growth: null };
  const growth = areaNow / areaAtBrief;
  return { stale: growth >= STALE_AREA_RATIO, growth };
}
