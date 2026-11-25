import { toWeather, type Weather } from "./workflow";

const VARS = "wind_speed_10m,wind_direction_10m,relative_humidity_2m,temperature_2m";
const TTL_S = 900;

/**
 * Current Open-Meteo reading at a point, cached 15 min per 0.1° square (Cache API). The incident card and the
 * copilot both show this one reading, so they agree and are never days old (the enrichment's weather is the
 * reading at enrichment time). Null when the lookup fails; callers fall back to the stored reading.
 */
export async function currentWeather(lat: number, lon: number): Promise<Weather | null> {
  const la = Math.round(lat * 10) / 10, lo = Math.round(lon * 10) / 10;
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(`https://weather.internal/${la}/${lo}`);
  try {
    const hit = await cache.match(key);
    if (hit) return (await hit.json()) as Weather;
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&current=${VARS}&wind_speed_unit=kmh&timezone=UTC`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const c = ((await res.json()) as { current: Record<string, number | string> }).current;
    const w = toWeather("open-meteo-forecast", String(c.time), c);
    await cache.put(key, new Response(JSON.stringify(w), { headers: { "cache-control": `max-age=${TTL_S}` } }));
    return w;
  } catch {
    return null;
  }
}
