/**
 * Gas-flare mask for the live path: the EOG VIIRS Nightfire flare-site cells that the archive harmonization already
 * uses (config/flares/eog_myc25q4_cells.csv; this file's JSON is the same cell ids, see test and README).
 * Source: Zhizhin et al. (2026), VIIRS Nightfire upstream gas-flaring volumes 2012-2025 (MYC25Q4), doi:10.5281/zenodo.23091822,
 * CC BY-NC 4.0. Incidents are labelled, never dropped.
 */

import cells from "./flare-cells.json";
import { parseCellKey } from "./grid";

const FLARE_CELLS = new Set<number>(cells as number[]);
const COLS = 7200; // 360° / 0.05°

/** An incident is "Gas flare" when at least this share of its cells are inventory flare cells. */
export const FLARE_MIN_CELL_SHARE = 0.5;

export const isFlareCellId = (id: number): boolean => FLARE_CELLS.has(id);

/** Archive cell id of a worker cell key ("row:col"); same grid as the EOG list. */
export function flareCellKey(key: string): boolean {
  const { row, col } = parseCellKey(key);
  return FLARE_CELLS.has(row * COLS + col);
}

export function isFlareIncident(cellKeys: string[]): boolean {
  if (!cellKeys.length) return false;
  let hit = 0;
  for (const k of cellKeys) if (flareCellKey(k)) hit++;
  return hit / cellKeys.length >= FLARE_MIN_CELL_SHARE;
}

/** Point lookup (centroid), used for summaries stored before `flare` existed. */
export function isFlarePoint(lon: number, lat: number): boolean {
  return FLARE_CELLS.has(Math.floor((lat + 90) * 20 + 1e-9) * COLS + Math.floor((lon + 180) * 20 + 1e-9));
}
