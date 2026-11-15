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
    `Area of active 0.05 degree grid cells: ${s.areaKm2} km2 (${s.cells} cells)`,
    `New area in the last 24 hours: ${s.growthKm2PerDay} km2`,
    `Peak fire radiative power: ${s.frpMaxMw} MW`,
    `First detected: ${iso(s.firstSeen)}; latest detection: ${iso(s.lastSeen)}`,
    `Centre: ${s.centroid[1].toFixed(2)}, ${s.centroid[0].toFixed(2)} (lat, lon)`
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
        "Lead with the size and the last-24-hour growth, then the weather, then the nearest town if one is given. " +
        "Do not restate coordinates or list every number. " +
        "Never give evacuation or safety advice. Do not use dashes as punctuation. No headings, no lists, no preamble."
    },
    { role: "user", content: `Facts:\n- ${facts.join("\n- ")}\n\nWrite the brief.` }
  ];
}

/** Strip reasoning tags/markdown, replace em/en dashes, drop advice sentences, keep at most 3 sentences. */
export function cleanBrief(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/[*#_`]/g, "").trim();
  t = t.replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ");
  // Split only where a sentence end is followed by whitespace, so decimals ("47.8 km2") stay intact.
  const sentences = t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  const kept = sentences.filter((x) => !/evacuat|shelter in place|stay safe|leave the area|should (?:avoid|leave)/i.test(x));
  return kept.slice(0, 3).join(" ").trim();
}
