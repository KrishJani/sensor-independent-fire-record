/** Brief prompt + output cleanup (pure; unit-tested). */

import type { IncidentSummary } from "../incidentModel";

type Step<T> = { status: "ok"; data: T } | { status: string };

interface BriefInput {
  summary: IncidentSummary;
  stream: string;
  weather: Step<{ windSpeedKmh: number | null; windFrom: string | null; relativeHumidityPct: number | null; temperatureC: number | null }>;
  places: Step<{ name: string; distanceKm: number; direction: string }[]>;
  history: Step<{ dataSource: string; summary: unknown }>;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function buildBriefPrompt(i: BriefInput): { role: "system" | "user"; content: string }[] {
  const s = i.summary;
  const facts: string[] = [
    `Satellite fire detections (NASA FIRMS, ${s.sensors.VIIRS} VIIRS + ${s.sensors.MODIS} MODIS): ${s.detections}`,
    `Area with detections: ${s.affectedAreaKm2} km2 (${s.cells} grid cells of 0.05 degrees that contain at least one detection; this is larger than the area actually burned)`,
    `New area with detections in the last 24 hours: ${s.growthKm2PerDay} km2`,
    `Peak fire radiative power: ${s.frpMaxMw} MW`,
    `First detected: ${iso(s.firstSeen)}; latest detection: ${iso(s.lastSeen)}`
  ];
  if (i.weather.status === "ok" && "data" in i.weather) {
    const w = i.weather.data;
    if (w.windSpeedKmh !== null) facts.push(`Wind: ${w.windSpeedKmh} km/h from the ${w.windFrom}`);
    if (w.relativeHumidityPct !== null) facts.push(`Relative humidity: ${w.relativeHumidityPct}%`);
    if (w.temperatureC !== null) facts.push(`Temperature: ${w.temperatureC} C`);
  }
  if (i.places.status === "ok" && "data" in i.places && i.places.data.length) {
    facts.push(
      `Nearest towns: ${i.places.data
        .slice(0, 3)
        .map((p) => `${p.name} (${p.distanceKm} km ${p.direction})`)
        .join(", ")}`
    );
  }
  if (i.history.status === "ok" && "data" in i.history && i.history.data.dataSource === "live") {
    facts.push(`Historical context (archival calendar): ${JSON.stringify(i.history.data.summary).slice(0, 300)}`);
  }
  return [
    {
      role: "system",
      content:
        "You write short factual incident briefs for emergency managers. Write 2 or 3 plain sentences in English. " +
        "Use only the facts and numbers given; do not add causes, forecasts, names of fires, or any number not given. " +
        "Lead with the area with detections and its last-24-hour growth, then the weather, then the nearest town if one is given. " +
        'Always call the size "area with detections". Never call it burned area, never say the fire burned or covers that area. ' +
        "Do not give coordinates or list every number. If a fact (such as a town or the weather) is not given, leave it out without saying it is missing. " +
        "Never give evacuation or safety advice. Do not use dashes as punctuation. No headings, no lists, no preamble."
    },
    { role: "user", content: `Facts:\n- ${facts.join("\n- ")}\n\nWrite the brief.` }
  ];
}

/**
 * Strip reasoning tags/markdown, replace em/en dashes, never say "burned area", drop advice
 * sentences, keep at most 3 sentences.
 */
export function cleanBrief(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/[*#_`]/g, "").trim();
  t = t.replace(/\b(?:total )?(?:burned|burnt) area\b/gi, "area with detections");
  t = t.replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ");
  // Split only where a sentence end is followed by whitespace, so decimals ("47.8 km2") stay intact.
  const sentences = t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  // A reply cut off by max_tokens ends mid-sentence: drop the fragment if a full sentence precedes it.
  if (sentences.length > 1 && !/[.!?]$/.test(sentences.at(-1)!)) sentences.pop();
  const kept = sentences.filter((x) => !/evacuat|shelter in place|stay safe|leave the area|should (?:avoid|leave)/i.test(x));
  return kept.slice(0, 3).join(" ").trim();
}

/**
 * Replay brief cache key (REPLAY_KV). Replays are deterministic, so the same scenario + incident
 * (its first detection id) + area-doubling level gets the same brief. Bump the version when the
 * prompt changes.
 */
export const BRIEF_CACHE_VERSION = "v1";
export function briefCacheKey(scenario: string, stableKey: string, level: number): string {
  return `brief-cache/${BRIEF_CACHE_VERSION}/${scenario}/${stableKey}/${level}`;
}

const DEFAULT_BRIEF_MODEL = "@cf/moonshotai/kimi-k2.6";
/** Measured: 71–76 completion tokens per brief with reasoning off; 64 truncates. 120 leaves headroom. */
export const DEFAULT_BRIEF_MAX_TOKENS = 120;

/** CHAT_MODEL, then CHAT_FALLBACK_MODEL unless it is set to "" (fallback disabled). */
export function briefModels(env: Pick<Env, "CHAT_MODEL" | "CHAT_FALLBACK_MODEL">): string[] {
  const primary = env.CHAT_MODEL || DEFAULT_BRIEF_MODEL;
  const fallback = env.CHAT_FALLBACK_MODEL?.trim();
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

/**
 * BRIEF_REASONING_EFFORT (default "none") for kimi models only. kimi-k2.6 supports "high" and
 * "none"; "low"/"medium" are accepted but mapped to "high". "" sends nothing (model default).
 */
export function reasoningParams(env: Pick<Env, "BRIEF_REASONING_EFFORT">, model: string): { reasoning_effort?: string } {
  const effort = (env.BRIEF_REASONING_EFFORT ?? "none").trim();
  return effort && /kimi/i.test(model) ? { reasoning_effort: effort } : {};
}
