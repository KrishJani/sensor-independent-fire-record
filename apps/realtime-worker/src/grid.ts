/**
 * 0.05° grid helpers.
 * TODO(harmonizer): switch to the grid functions in packages/harmonizer (src/grid.ts)
 * once that package's API is stable. Kept local so this worker does not depend on
 * code that is still being written.
 */

export const CELL_DEG = 0.05;
const CELLS_PER_DEG = 20; // 1 / CELL_DEG, kept integral to avoid float drift
/** km per degree of latitude (mean). */
export const KM_PER_DEG = 111.32;

export interface Cell {
  row: number; // 0 at -90°
  col: number; // 0 at -180°
}

export type Bbox = [west: number, south: number, east: number, north: number];

export function cellOf(lat: number, lon: number): Cell {
  // The epsilon keeps values that sit exactly on a grid line (e.g. 45.05) in the upper cell
  // regardless of binary rounding.
  return {
    row: Math.floor((lat + 90) * CELLS_PER_DEG + 1e-9),
    col: Math.floor((lon + 180) * CELLS_PER_DEG + 1e-9)
  };
}

export function cellKey(c: Cell): string {
  return `${c.row}:${c.col}`;
}

export function parseCellKey(key: string): Cell {
  const [row, col] = key.split(":").map(Number);
  return { row, col };
}

/** The cell itself plus its 8 neighbours. */
export function neighborCells(c: Cell): Cell[] {
  const out: Cell[] = [];
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) out.push({ row: c.row + dr, col: c.col + dc });
  return out;
}

/** South-west corner and centre of a cell in degrees. */
export function cellCenter(c: Cell): { lat: number; lon: number } {
  return {
    lat: c.row / CELLS_PER_DEG - 90 + CELL_DEG / 2,
    lon: c.col / CELLS_PER_DEG - 180 + CELL_DEG / 2
  };
}

/** Area of one 0.05° cell in km² at the cell's centre latitude (cos(lat) shrink of the east-west side). */
export function cellAreaKm2(c: Cell): number {
  const { lat } = cellCenter(c);
  const side = CELL_DEG * KM_PER_DEG;
  return side * side * Math.cos((lat * Math.PI) / 180);
}

export function parseBbox(s: string | null | undefined): Bbox | null {
  if (!s) return null;
  const p = s.split(",").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null;
  const [w, so, e, n] = p;
  if (w < -180 || e > 180 || so < -90 || n > 90 || w >= e || so >= n) return null;
  return [w, so, e, n];
}

export function inBbox(lat: number, lon: number, b: Bbox): boolean {
  return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}

export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}
