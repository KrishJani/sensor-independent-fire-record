/** Static active-volcano mask (config/volcanoes.json, Smithsonian GVP). Pure; unit-tested. */

import mask from "../../../config/volcanoes.json";

export interface Volcano {
  number: number;
  name: string;
  country: string;
  lat: number;
  lon: number;
  lastEruptionYear: number;
  radiusKm: number;
}
export interface VolcanoMatch {
  name: string;
  distanceKm: number;
}

const VOLCANOES = mask.volcanoes as Volcano[];

function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** The masked volcano whose radius contains the point (nearest if several), or null. */
export function volcanoNear(lon: number, lat: number, list: Volcano[] = VOLCANOES): VolcanoMatch | null {
  let best: VolcanoMatch | null = null;
  for (const v of list) {
    if (Math.abs(v.lat - lat) > 1) continue; // cheap reject (45 km ≈ 0.4°)
    const d = haversineKm(lon, lat, v.lon, v.lat);
    if (d <= v.radiusKm && (!best || d < best.distanceKm)) best = { name: v.name, distanceKm: Math.round(d * 10) / 10 };
  }
  return best;
}
