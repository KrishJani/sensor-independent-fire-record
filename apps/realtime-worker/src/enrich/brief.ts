/** Brief prompt + output cleanup (pure; unit-tested). */

import type { IncidentSummary } from "../incidentModel";

type Step<T> = { status: "ok"; data: T } | { status: string };

interface BriefInput {
  summary: IncidentSummary;
  stream: string;
  weather: Step<{ windSpeedKmh: number | null; windFrom: string | null; relativeHumidityPct: number | null; temperatureC: number | null }>;
  places: Step<{ name: string; place?: string; distanceKm: number; direction: string }[]>;
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
      `Nearest populated places: ${i.places.data
        .slice(0, 3)
        .map((p) => `${p.name} (${p.place ? `${p.place}, ` : ""}${p.distanceKm} km ${p.direction})`)
        .join(", ")}`
    );
  }
  let hasHistory = false;
  if (i.history.status === "ok" && "data" in i.history && i.history.data.dataSource === "live") {
    hasHistory = true;
    facts.push(`Historical context (archival calendar, VIIRS-equivalent 0.05° cell-days): ${String(i.history.data.summary).slice(0, 300)}`);
  }
  return [
    {
      role: "system",
      content:
        "You write short factual incident briefs for emergency managers. Write 2 or 3 plain sentences in English. " +
        "Use only the facts and numbers given; do not add causes, forecasts, names of fires, or any number not given. " +
        "Lead with the area with detections and its last-24-hour growth, then the weather, then the nearest populated place if one is given (say its type, e.g. the village of X). " +
        // Only when history exists: mentioning it otherwise makes the model say "no historical context was provided".
        (hasHistory
          ? "Write exactly 3 sentences: (1) area with detections and growth, (2) wind, humidity and the single nearest place in one sentence, (3) what the archive says is typical for this month here (the typical month value in active cell-days) and the fire season months. "
          : "") +
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
  const kept = sentences.filter(
    (x) =>
      !/evacuat|shelter in place|stay safe|leave the area|should (?:avoid|leave)/i.test(x) &&
      // the model sometimes remarks on facts it was not given ("No historical context was provided ...")
      !/\b(?:not|no|wasn't|were not|was not)\b[^.]*\b(?:provided|given|available)\b/i.test(x)
  );
  return kept.slice(0, 3).join(" ").trim();
}

/**
 * Replay brief cache key (REPLAY_KV). Replays are deterministic, so the same scenario + incident
 * (its first detection id) + area-doubling level gets the same brief. Bump the version when the
 * prompt changes.
 */
export const BRIEF_CACHE_VERSION = "v8"; // v8: Claude Haiku 5.5 (v7 held glm fallback briefs; kimi briefs were v6); v6: history instruction only when history exists; v5: outside-coverage wording; v4: archival history sentence (single-account deploy); v2: places within 75 km
export function briefCacheKey(scenario: string, stableKey: string, level: number): string {
  return `${briefCachePrefix(scenario, stableKey)}${level}`;
}

/** KV list prefix for one scenario's cached briefs, or one incident's within it. */
export function briefCachePrefix(scenario: string, stableKey?: string): string {
  return `brief-cache/${BRIEF_CACHE_VERSION}/${scenario}/${stableKey ? `${stableKey}/` : ""}`;
}

/** AI Gateway catalog id (Claude Haiku 5.5); billed via Unified Billing or a key stored on the gateway. */
const DEFAULT_BRIEF_MODEL = "anthropic/claude-haiku-5.5";
/**
 * Claude Haiku 5.5 always reasons first and those tokens count against the cap: at 120 a brief came back
 * empty (finishReason "length", all 120 tokens reasoning). A brief is ~175 reasoning + ~45 text tokens; 1024 is the ceiling.
 */
export const DEFAULT_BRIEF_MAX_TOKENS = 1024;

/** CHAT_MODEL, then CHAT_FALLBACK_MODEL unless it is set to "" (fallback disabled). */
export function briefModels(env: Pick<Env, "CHAT_MODEL" | "CHAT_FALLBACK_MODEL">): string[] {
  const primary = env.CHAT_MODEL || DEFAULT_BRIEF_MODEL;
  const fallback = env.CHAT_FALLBACK_MODEL?.trim();
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}
