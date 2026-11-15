// Request validation and error shape: { error: { code, message } } with 400 / 413 / 422 / 500.
import { HTTPException } from 'hono/http-exception';
import { pointInPolygon, snapBboxOutward, type Bbox, type PolygonGeometry } from '@repo/harmonizer';

export class ApiError extends Error {
  constructor(public status: 400 | 404 | 413 | 422 | 500 | 503, public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

export function parseBbox(raw: string | undefined | null, maxArea: number): Bbox {
  if (!raw) throw new ApiError(400, 'bbox_required', 'bbox=w,s,e,n is required');
  const p = raw.split(',').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) throw new ApiError(400, 'bbox_invalid', 'bbox must be four numbers: west,south,east,north');
  const [w, s, e, n] = p;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) throw new ApiError(400, 'bbox_invalid', 'bbox must satisfy -180 ≤ west < east ≤ 180 and -90 ≤ south < north ≤ 90');
  const b = snapBboxOutward([w, s, e, n]);
  const area = (b[2] - b[0]) * (b[3] - b[1]);
  if (area > maxArea) throw new ApiError(413, 'bbox_too_large', `bbox covers ${area.toFixed(1)} deg²; this level allows ${maxArea} deg². Zoom in or use a coarser level.`);
  return b;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function parseDate(raw: string | undefined | null, fallback: string, name: string): string {
  if (!raw) return fallback;
  if (!ISO.test(raw) || Number.isNaN(Date.parse(raw))) throw new ApiError(400, 'date_invalid', `${name} must be YYYY-MM-DD`);
  return raw;
}
export function clampRange(from: string, to: string, min: string, max: string): { from: string; to: string } {
  const f = from < min ? min : from;
  const t = to > max ? max : to;
  if (f > t) throw new ApiError(422, 'range_empty', `no data between ${from} and ${to} (archive covers ${min} → ${max})`);
  return { from: f, to: t };
}

/** GeoJSON Polygon/MultiPolygon → its bbox, with a vertex cap. */
export function polygonBbox(g: unknown): { geom: PolygonGeometry; bbox: Bbox } {
  const geom = g as PolygonGeometry;
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) throw new ApiError(400, 'geometry_invalid', 'geometry must be a GeoJSON Polygon or MultiPolygon');
  const rings = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat();
  const pts = rings.flat();
  if (pts.length < 4 || pts.length > 500) throw new ApiError(400, 'geometry_invalid', 'geometry needs 4–500 vertices');
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  return { geom, bbox: snapBboxOutward([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]) };
}
export { pointInPolygon };

export function toHttp(err: unknown): { status: number; body: { error: { code: string; message: string } & Record<string, unknown> } } {
  if (err instanceof ApiError) return { status: err.status, body: { error: { ...err.details, code: err.code, message: err.message } } };
  if (err instanceof HTTPException) return { status: err.status, body: { error: { code: 'http_error', message: err.message } } };
  console.log(JSON.stringify({ level: 'error', message: (err as Error)?.message, stack: (err as Error)?.stack?.split('\n').slice(0, 4) }));
  return { status: 500, body: { error: { code: 'internal', message: 'Internal error' } } };
}
