// Harmonized coverage of an AOI: the share of its 0.05° cells (by cell centre) that lie inside a harmonized
// region AND on US territory. The regions are rectangles (config/regions.json), but the archive was loaded from
// FIRMS USA country files, so e.g. southern Quebec sits inside midwest_northeast's rectangle with no data.
// The US mask below is deliberately coarse (border to ~0.1–0.3°) and counts nearby ocean as covered, so coastal
// views are not penalized. It only decides "is this view mostly outside the archive"; it never changes numbers.

import { cellCenter, cellInRegion, inBbox, type Bbox } from '@repo/harmonizer';
import regionsConfig from '../../../../config/regions.json';

type Ring = [number, number][]; // [lon, lat]

// Lower 48: Pacific offshore → Mexico border → Gulf/Atlantic offshore → Maine/New Brunswick → St Lawrence /
// Great Lakes midlines → 49th parallel → Strait of Juan de Fuca.
const LOWER48: Ring = [
  [-125.5, 48.4], [-125.5, 36], [-120, 32.3], [-117.1, 32.5], [-114.7, 32.7], [-114.8, 32.5], [-111.1, 31.33],
  [-108.2, 31.33], [-108.2, 31.78], [-106.5, 31.78], [-104.9, 30.6], [-104.4, 29.6], [-103.1, 29.0], [-102.4, 29.8],
  [-101.4, 29.8], [-100.9, 29.4], [-99.5, 27.5], [-99.1, 26.4], [-97.4, 25.9], [-97.0, 25.5], [-96, 24], [-80, 24],
  [-79.5, 24], [-79.5, 27], [-75, 35], [-69.5, 41], [-66.5, 44.5], [-66.9, 44.8], [-67.8, 45.7], [-67.8, 47.1],
  [-68.3, 47.35], [-69.2, 47.45], [-70.0, 46.7], [-70.3, 45.9], [-71.1, 45.3], [-71.5, 45.0], [-74.7, 45.0],
  [-76.3, 44.2], [-79.2, 43.5], [-79.0, 43.1], [-79.0, 42.6], [-81.0, 42.3], [-82.7, 41.9], [-83.1, 42.3],
  [-82.5, 42.9], [-82.4, 43.0], [-82.5, 45.3], [-83.6, 45.9], [-83.6, 46.1], [-84.1, 46.5], [-84.8, 46.9],
  [-88.4, 48.3], [-89.6, 48.0], [-91.5, 48.05], [-93.0, 48.6], [-94.6, 48.7], [-95.15, 49.0], [-123.3, 49.0],
  [-123.2, 48.7], [-124.7, 48.5],
];
// Alaska: west of 141°W, plus the panhandle.
const ALASKA: Ring = [
  [-180, 51], [-180, 72], [-141, 72], [-141, 60.3], [-139, 60], [-137.5, 59.2], [-135.5, 59.8], [-133.5, 58.5],
  [-131, 56], [-130, 55.7], [-130, 54.6], [-133, 54.5], [-170, 51],
];
const HAWAII: Bbox = [-161, 18.5, -154.5, 22.5];

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inUS(lon: number, lat: number): boolean {
  return inBbox(lat, lon, HAWAII) || inRing(lon, lat, LOWER48) || inRing(lon, lat, ALASKA);
}

interface RegionDef { id: string; bbox: Bbox; exclude?: string[] }
const REGIONS = (regionsConfig as unknown as { regions: RegionDef[] }).regions;
const BBOX = new Map(REGIONS.map((r) => [r.id, r.bbox]));
const EXCLUDED = new Map(REGIONS.map((r) => [r.id, (r.exclude ?? []).map((id) => BBOX.get(id)!)]));

function covered(cellId: number): boolean {
  if (!REGIONS.some((r) => cellInRegion(cellId, r.bbox, EXCLUDED.get(r.id)))) return false;
  const { lon, lat } = cellCenter(cellId);
  return inUS(lon, lat);
}

/** Below this share the calendar answers 422 outside_regions. */
export const MIN_COVERAGE = 0.5;

/**
 * Share (0..1) of the AOI's 0.05° cells that are harmonized. `cells` (polygon AOIs) is used as is; a bbox is
 * sampled on a stride so a 400 deg² view costs ≤ ~40k checks.
 */
export function coverage(bbox: Bbox, cells: number[] | null = null): number {
  if (cells) return cells.length ? cells.filter(covered).length / cells.length : 0;
  const r0 = Math.floor((bbox[1] + 90) * 20), r1 = Math.ceil((bbox[3] + 90) * 20) - 1;
  const c0 = Math.floor((bbox[0] + 180) * 20), c1 = Math.ceil((bbox[2] + 180) * 20) - 1;
  const n = (r1 - r0 + 1) * (c1 - c0 + 1);
  const stride = Math.max(1, Math.ceil(Math.sqrt(n / 40000)));
  let tot = 0, hit = 0;
  for (let row = r0; row <= r1; row += stride)
    for (let col = c0; col <= c1; col += stride) {
      tot++;
      if (covered(row * 7200 + col)) hit++;
    }
  return tot ? hit / tot : 0;
}
