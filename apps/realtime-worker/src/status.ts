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

/**
 * "Persistent heat": many detections on few cells at low power: >= 30 detections per cell and mean FRP < 20 MW.
 * A neutral label with no claim about the cause (a wildfire front moves across cells; this does not). Chosen on the
 * live list (23 of 190 incidents match, e.g. NW Indiana and St. Louis); not validated against wildfire scenarios.
 */
export const PERSISTENT_MIN_DETECTIONS_PER_CELL = 30;
export const PERSISTENT_MAX_MEAN_FRP_MW = 20;
export function isPersistentHeat(i: { detections: number; cells: number; frpTotalMw: number }): boolean {
  if (i.cells <= 0 || i.detections <= 0) return false;
  return i.detections / i.cells >= PERSISTENT_MIN_DETECTIONS_PER_CELL && i.frpTotalMw / i.detections < PERSISTENT_MAX_MEAN_FRP_MW;
}

/** List order: wildfires (0), persistent heat (1), gas flare (2), volcanic heat (3). */
export function heatRank(i: { detections: number; cells: number; frpTotalMw: number; volcano?: unknown; flare?: boolean }): number {
  return i.volcano ? 3 : i.flare ? 2 : isPersistentHeat(i) ? 1 : 0;
}

export const activityRank = (a: Activity): number => (a === "active" ? 0 : a === "cooling" ? 1 : 2);

/** Show "growing" only for an incident that gained cells in the last 24 h AND is still active. */
export function isGrowing(i: { growthKm2PerDay: number; lastSeen: number }, streamT: number): boolean {
  return i.growthKm2PerDay > 0 && activityAt(i.lastSeen, streamT) === "active";
}

/**
 * List order at stream time `streamT`: wildfires before persistent heat before volcanic heat; within each,
 * Active before Cooling before Inactive; then larger grid coverage first, then most recently seen.
 */
export function compareIncidents(
  a: { detections: number; cells: number; frpTotalMw: number; volcano?: unknown; flare?: boolean; lastSeen: number; affectedAreaKm2: number },
  b: { detections: number; cells: number; frpTotalMw: number; volcano?: unknown; flare?: boolean; lastSeen: number; affectedAreaKm2: number },
  streamT: number
): number {
  return (
    heatRank(a) - heatRank(b) ||
    activityRank(activityAt(a.lastSeen, streamT)) - activityRank(activityAt(b.lastSeen, streamT)) ||
    b.affectedAreaKm2 - a.affectedAreaKm2 ||
    b.lastSeen - a.lastSeen
  );
}
