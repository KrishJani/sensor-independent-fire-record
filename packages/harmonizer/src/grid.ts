// Fixed global 0.05° grid (harmonizer SPEC §5). 3600 rows × 7200 cols.

export const GRID_DEG = 0.05;
const INV = 20; // 1 / GRID_DEG, exact in binary unlike 0.05
export const GRID_ROWS = 3600;
export const GRID_COLS = 7200;
// Multiplying by 20 is exact for typical 4–5 dp inputs, but guard against e.g. 34.65*20 = 692.9999999.
const EPS = 1e-9;

export type Bbox = [west: number, south: number, east: number, north: number];

export function latToRow(lat: number): number {
  const r = Math.floor((lat + 90) * INV + EPS);
  return r < 0 ? 0 : r > GRID_ROWS - 1 ? GRID_ROWS - 1 : r;
}

export function lonToCol(lon: number): number {
  const c = Math.floor((lon + 180) * INV + EPS);
  return c < 0 ? 0 : c > GRID_COLS - 1 ? GRID_COLS - 1 : c;
}

export function toCellId(lat: number, lon: number): number {
  return latToRow(lat) * GRID_COLS + lonToCol(lon);
}

export function cellRowCol(cellId: number): { row: number; col: number } {
  return { row: Math.floor(cellId / GRID_COLS), col: cellId % GRID_COLS };
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Cell center, rounded to 4 dp (exact for a 0.05° grid: centers end in .x25 / .x75). */
export function cellCenter(cellId: number): { lat: number; lon: number } {
  const { row, col } = cellRowCol(cellId);
  return { lat: round4(-90 + (row + 0.5) * GRID_DEG), lon: round4(-180 + (col + 0.5) * GRID_DEG) };
}

export function cellsInBbox(bbox: Bbox): { rowMin: number; rowMax: number; colMin: number; colMax: number } {
  const [w, s, e, n] = bbox;
  return { rowMin: latToRow(s), rowMax: latToRow(n), colMin: lonToCol(w), colMax: lonToCol(e) };
}

/** Snap a bbox outward to grid lines. */
export function snapBboxOutward(bbox: Bbox): Bbox {
  const [w, s, e, n] = bbox;
  const down = (x: number) => Math.floor(x * INV + EPS) / INV;
  const up = (x: number) => Math.ceil(x * INV - EPS) / INV;
  return [Math.max(-180, down(w)), Math.max(-90, down(s)), Math.min(180, up(e)), Math.min(90, up(n))];
}

export function inBbox(lat: number, lon: number, bbox: Bbox): boolean {
  return lon >= bbox[0] && lat >= bbox[1] && lon <= bbox[2] && lat <= bbox[3];
}

/** Coarse bin (e.g. 0.5° = 10×10 cells) for the `coarse` map level. */
export function coarseBin(cellId: number, binDeg = 0.5): { binRow: number; binCol: number; binId: number } {
  const f = Math.round(binDeg * INV);
  const { row, col } = cellRowCol(cellId);
  const binRow = Math.floor(row / f);
  const binCol = Math.floor(col / f);
  return { binRow, binCol, binId: binRow * Math.ceil(GRID_COLS / f) + binCol };
}

export type Position = [number, number]; // [lon, lat]
export type PolygonGeometry =
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

function inRing(lon: number, lat: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Even-odd point-in-polygon with hole support. Applied to cell centers. */
export function pointInPolygon(lon: number, lat: number, geom: PolygonGeometry): boolean {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const rings of polys) {
    if (!rings.length || !inRing(lon, lat, rings[0])) continue;
    let inHole = false;
    for (let h = 1; h < rings.length; h++) if (inRing(lon, lat, rings[h])) inHole = true;
    if (!inHole) return true;
  }
  return false;
}
