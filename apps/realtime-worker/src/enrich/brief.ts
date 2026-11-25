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

/** Words for how the incident is moving (stream clock), so the brief does not repeat the card's numbers. */
export function trendWords(s: IncidentSummary): string {
  const a = s.activity ?? "active";
  const growing = s.growthKm2PerDay > 0 ? (s.affectedAreaKm2 > 0 && s.growthKm2PerDay / s.affectedAreaKm2 >= 0.1 ? "still spreading (new cells in the last 24 hours)" : "adding a few new cells") : "no new cells in the last 24 hours";
  return a === "active" ? `active, ${growing}` : a === "cooling" ? `cooling, last detection 12 to 36 hours ago, ${growing}` : `inactive, no detection for over 36 hours`;
}

/**
 * The incident card already shows detections, cells, area, growth, FRP, times, wind and towns, so the brief
 * adds what the card does not: how the incident is moving in words, where it is, and one sentence on how its
 * REGION's month compares with the region's own 2001-2025 median (never presented as the incident's own area).
 */
export function buildBriefPrompt(i: BriefInput): { role: "system" | "user"; content: string }[] {
  const s = i.summary;
  const facts: string[] = [`Status: ${trendWords(s)}`];
  if (i.places.status === "ok" && "data" in i.places && i.places.data.length) {
    const p = i.places.data[0];
    facts.push(`Nearest populated place: ${p.name} (${p.place ? `${p.place}, ` : ""}${p.distanceKm} km ${p.direction})`);
  }
  if (i.weather.status === "ok" && "data" in i.weather) {
    const w = i.weather.data;
    const bits = [
      w.windSpeedKmh !== null && w.windFrom ? `wind ${w.windSpeedKmh} km/h from the ${w.windFrom}` : null,
      w.relativeHumidityPct !== null ? `relative humidity ${w.relativeHumidityPct}%` : null
    ].filter(Boolean);
    if (bits.length) facts.push(`Weather now: ${bits.join(", ")}`);
  }
  let hasContext = false;
  if (i.history.status === "ok" && "data" in i.history && i.history.data.dataSource === "live") {
    hasContext = true;
    facts.push(`Regional context (about the whole region, NOT this incident): ${String(i.history.data.summary).slice(0, 400)}`);
  }
  return [
    {
      role: "system",
      content:
        "You write short factual incident briefs for emergency managers, shown under a card that already lists the detection count, grid cells, area, growth, peak power, times, wind and nearby towns. " +
        "Do not repeat those numbers. Write 2 or 3 plain sentences in English that add what the card does not show. " +
        "Use only the facts given; do not add causes, forecasts, names of fires, or any number not given. " +
        (hasContext
          ? "Write exactly 3 sentences: (1) where the incident is (the nearest place, its type e.g. the village of X) and whether it is spreading, steady or cooling, in words; (2) what the wind and humidity mean for the next hours, only if given; (3) the regional context sentence, keeping its region name and numbers, and making clear it describes the whole region. "
          : "Write 2 sentences: where the incident is (the nearest place, its type) and whether it is spreading, steady or cooling, then the wind and humidity if given. ") +
        'If you mention size call it "area with detections", never burned area. ' +
        "No coordinates. If a fact is not given, leave it out without saying it is missing. " +
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
export const BRIEF_CACHE_VERSION = "v9"; // v9: briefs add region context instead of restating the card; v8: Claude Haiku 5.5 (v7 held glm fallback briefs; kimi briefs were v6); v6: history instruction only when history exists; v5: outside-coverage wording; v4: archival history sentence (single-account deploy); v2: places within 75 km
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
