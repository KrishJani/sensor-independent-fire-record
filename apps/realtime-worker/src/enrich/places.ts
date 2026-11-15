/**
 * Nearby populated places for an incident (pure helpers + the fetch chain used by the Workflow).
 * Overpass first, Photon (komoot) reverse geocoding as the fallback: from Workers, Overpass often
 * times out or refuses connections, which left every Quebec incident without towns.
 */

import { haversineKm } from "../grid";

export const PLACES_RADIUS_KM = 75;
/** Place kinds, most significant first (ranking ties on distance use this order). */
export const PLACE_KINDS = ["city", "town", "village", "hamlet", "locality"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

export interface Place {
  name: string;
  place: PlaceKind;
  distanceKm: number;
  direction: string;
  population: number | null;
}

export type PlacesSource = "overpass" | "photon";

const OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const PHOTON = "https://photon.komoot.io/reverse";
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

const isKind = (k: unknown): k is PlaceKind => typeof k === "string" && (PLACE_KINDS as readonly string[]).includes(k);

function toPlace(lat: number, lon: number, name: string, kind: PlaceKind, pLat: number, pLon: number, population: unknown): Place {
  const pop = typeof population === "string" || typeof population === "number" ? Number(String(population).replace(/[^\d]/g, "")) || null : null;
  return {
    name,
    place: kind,
    distanceKm: Math.round(haversineKm(lat, lon, pLat, pLon) * 10) / 10,
    direction: compass(bearing(lat, lon, pLat, pLon)),
    population: pop
  };
}

/** Within the radius, one entry per name, nearest first; cities/towns win ties within 5 km. */
export function finalizePlaces(places: Place[], max = 8): Place[] {
  const byName = new Map<string, Place>();
  for (const p of places) {
    if (p.distanceKm > PLACES_RADIUS_KM) continue;
    const prev = byName.get(p.name);
    if (!prev || p.distanceKm < prev.distanceKm) byName.set(p.name, p);
  }
  const rank = (p: Place) => PLACE_KINDS.indexOf(p.place);
  return [...byName.values()]
    .sort((a, b) => (Math.abs(a.distanceKm - b.distanceKm) <= 5 ? rank(a) - rank(b) : 0) || a.distanceKm - b.distanceKm)
    .slice(0, max);
}

type OverpassElement = { lat: number; lon: number; tags?: Record<string, string> };

export function parseOverpass(elements: OverpassElement[], lat: number, lon: number): Place[] {
  return elements
    .filter((e) => e.tags?.name && isKind(e.tags.place))
    .map((e) => toPlace(lat, lon, e.tags!["name:en"] ?? e.tags!.name, e.tags!.place as PlaceKind, e.lat, e.lon, e.tags!.population));
}

type PhotonFeature = { geometry?: { coordinates?: [number, number] }; properties?: Record<string, unknown> };

export function parsePhoton(features: PhotonFeature[], lat: number, lon: number): Place[] {
  return features
    .filter((f) => f.properties?.osm_key === "place" && typeof f.properties.name === "string" && isKind(f.properties.osm_value) && f.geometry?.coordinates)
    .map((f) => {
      const [pLon, pLat] = f.geometry!.coordinates!;
      return toPlace(lat, lon, f.properties!.name as string, f.properties!.osm_value as PlaceKind, pLat, pLon, f.properties!.population);
    });
}

export type FetchJson = (url: string, init?: RequestInit, timeoutMs?: number) => Promise<unknown>;

/**
 * Overpass endpoints in turn, then Photon. Returns the first source that answers (an empty list
 * is a real "nothing within 75 km"); throws with every source's error when none answers.
 */
export async function fetchPlaces(fetchJson: FetchJson, lat: number, lon: number): Promise<{ places: Place[]; source: PlacesSource }> {
  const errors: string[] = [];
  const q = `[out:json][timeout:8];node(around:${PLACES_RADIUS_KM * 1000},${lat},${lon})[place~"^(${PLACE_KINDS.join("|")})$"];out tags 80;`;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const j = (await fetchJson(
        endpoint,
        { method: "POST", body: new URLSearchParams({ data: q }), headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        8_000
      )) as { elements?: OverpassElement[] };
      return { places: finalizePlaces(parseOverpass(j.elements ?? [], lat, lon)), source: "overpass" };
    } catch (err) {
      errors.push(`${new URL(endpoint).host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    const tags = PLACE_KINDS.map((k) => `osm_tag=place:${k}`).join("&");
    const j = (await fetchJson(`${PHOTON}?lat=${lat}&lon=${lon}&radius=${PLACES_RADIUS_KM}&limit=40&${tags}`, {}, 10_000)) as { features?: PhotonFeature[] };
    return { places: finalizePlaces(parsePhoton(j.features ?? [], lat, lon)), source: "photon" };
  } catch (err) {
    errors.push(`photon.komoot.io: ${err instanceof Error ? err.message : String(err)}`);
  }
  throw new Error(errors.join("; "));
}
