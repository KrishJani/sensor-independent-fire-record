import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { haversineKm } from "../grid";
import type { IncidentSummary } from "../incidentModel";
import type { Brief } from "../protocol";
import { briefModels, buildBriefPrompt, cleanBrief, DEFAULT_BRIEF_MAX_TOKENS, reasoningParams } from "./brief";

export interface EnrichParams {
  incidentId: string;
  stream: string;
  reason: "significant" | "area_doubled";
  streamT: number;
  summary: IncidentSummary;
}

type StepResult<T> = { status: "ok"; data: T } | { status: "failed"; error: string } | { status: "skipped"; reason: string };

export interface Weather {
  source: "open-meteo-forecast" | "open-meteo-archive";
  time: string;
  windSpeedKmh: number | null;
  windDirectionDeg: number | null;
  windFrom: string | null;
  relativeHumidityPct: number | null;
  temperatureC: number | null;
}

export interface Place {
  name: string;
  place: string;
  distanceKm: number;
  direction: string;
  population: number | null;
}

export interface HistoryContext {
  dataSource: string;
  summary: unknown;
}

export interface Enrichment {
  incidentId: string;
  reason: EnrichParams["reason"];
  streamT: number;
  weather: StepResult<Weather>;
  places: StepResult<Place[]>;
  history: StepResult<HistoryContext>;
  brief: StepResult<Brief>;
  completedAt: number;
}

const UA = "skywalkers77-fire-realtime/1.0 (NASA Space Apps 2026 demo; https://github.com/skywalkers77)";
const OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": UA, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * INCIDENT_ENRICH: weather → nearby places → historical context → AI brief → store + broadcast.
 * Every step has retries and a timeout; a step that still fails is recorded, never fatal.
 */
export class IncidentEnrichWorkflow extends WorkflowEntrypoint<Env, EnrichParams> {
  async run(event: WorkflowEvent<EnrichParams>, step: WorkflowStep): Promise<Enrichment> {
    const p = event.payload;
    const [lon, lat] = p.summary.centroid;
    const live = p.stream === "live";

    const safe = async <T>(name: string, cfg: Parameters<WorkflowStep["do"]>[1], fn: () => Promise<StepResult<T>>): Promise<StepResult<T>> => {
      try {
        return (await step.do(name, cfg, fn as never)) as StepResult<T>;
      } catch (err) {
        return { status: "failed", error: err instanceof Error ? err.message : String(err) };
      }
    };

    const weather = await safe<Weather>("weather", { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "20 seconds" }, async () => {
      const vars = "wind_speed_10m,wind_direction_10m,relative_humidity_2m,temperature_2m";
      if (live) {
        const j = (await fetchJson(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=${vars}&wind_speed_unit=kmh&timezone=UTC`
        )) as { current: Record<string, number | string> };
        const c = j.current;
        return { status: "ok", data: toWeather("open-meteo-forecast", String(c.time), c) };
      }
      // Replay: historical archive at stream time.
      const day = new Date(p.streamT).toISOString().slice(0, 10);
      const j = (await fetchJson(
        `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${day}&end_date=${day}&hourly=${vars}&wind_speed_unit=kmh&timezone=UTC`
      )) as { hourly: Record<string, (number | string)[]> };
      const h = j.hourly;
      const hour = new Date(p.streamT).getUTCHours();
      const pick = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v[Math.min(hour, v.length - 1)]]));
      return { status: "ok", data: toWeather("open-meteo-archive", String(pick.time), pick) };
    });

    const places = await safe<Place[]>("nearby-places", { retries: { limit: 2, delay: "3 seconds", backoff: "exponential" }, timeout: "15 seconds" }, async () => {
      const q = `[out:json][timeout:10];node(around:30000,${lat},${lon})[place~"^(city|town)$"];out tags 40;`;
      type OverpassResult = { elements: { lat: number; lon: number; tags?: Record<string, string> }[] };
      let j = null as OverpassResult | null;
      const errors: string[] = [];
      for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
          j = (await fetchJson(
            endpoint,
            { method: "POST", body: new URLSearchParams({ data: q }), headers: { "Content-Type": "application/x-www-form-urlencoded" } },
            10_000
          )) as OverpassResult;
          break;
        } catch (err) {
          errors.push(`${new URL(endpoint).host}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!j) throw new Error(errors.join("; "));
      const elements: OverpassResult["elements"] = j.elements ?? [];
      const out: Place[] = elements
        .filter((e) => e.tags?.name)
        .map((e) => ({
          name: e.tags!["name:en"] ?? e.tags!.name,
          place: e.tags!.place,
          distanceKm: Math.round(haversineKm(lat, lon, e.lat, e.lon) * 10) / 10,
          direction: compass(bearing(lat, lon, e.lat, e.lon)),
          population: e.tags!.population ? Number(e.tags!.population.replace(/[^\d]/g, "")) || null : null
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 8);
      return { status: "ok", data: out };
    });

    const history = await safe<HistoryContext>("historical-context", { retries: { limit: 1, delay: "2 seconds" }, timeout: "20 seconds" }, async () => {
      if (!this.env.API) return { status: "skipped", reason: "no API service binding" };
      const year = new Date(p.streamT).getUTCFullYear();
      let res: Response;
      try {
        res = await this.env.API.fetch("https://api-worker/api/calendar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "archival", bbox: p.summary.bbox, from: `${Math.max(2001, year - 15)}-01-01`, to: `${year - 1}-12-31` })
        });
      } catch (err) {
        return { status: "skipped", reason: `api-worker unavailable: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (res.status === 404 || res.status === 503) return { status: "skipped", reason: `api-worker /api/calendar not available (HTTP ${res.status})` };
      if (!res.ok) throw new Error(`api-worker /api/calendar HTTP ${res.status}`);
      const j = (await res.json()) as { dataSource?: string; summary?: unknown; climatology?: unknown };
      return { status: "ok", data: { dataSource: j.dataSource ?? "live", summary: j.summary ?? null } };
    });

    const brief = await safe<Brief>("brief", { retries: { limit: 1, delay: "5 seconds" }, timeout: "3 minutes" }, async () => {
      const prompt = buildBriefPrompt({ summary: p.summary, stream: p.stream, weather, places, history });
      const models = briefModels(this.env);
      const maxTokens = Number(this.env.BRIEF_MAX_TOKENS) || DEFAULT_BRIEF_MAX_TOKENS;
      let lastErr = "";
      for (const model of models) {
        const started = Date.now();
        try {
          const out = await this.env.AI.run(
            model as keyof AiModels,
            { messages: prompt, max_tokens: maxTokens, temperature: 0.2, ...reasoningParams(this.env, model) } as never,
            { gateway: { id: this.env.AI_GATEWAY_ID } }
          );
          const latencyMs = Date.now() - started;
          const text = cleanBrief(extractText(out));
          console.log(JSON.stringify({ msg: "brief_model_done", incident: p.incidentId, model, latencyMs, ok: !!text, usage: (out as { usage?: unknown })?.usage ?? null }));
          if (text)
            return { status: "ok", data: { text, model, generatedAt: Date.now(), streamT: p.streamT, asOf: new Date(p.streamT).toISOString(), latencyMs } };
          lastErr = `${model}: empty response (${JSON.stringify(out).slice(0, 200)})`;
        } catch (err) {
          lastErr = `${model}: ${err instanceof Error ? err.message : String(err)}`;
        }
        console.warn(JSON.stringify({ msg: "brief_model_failed", incident: p.incidentId, error: lastErr }));
      }
      throw new Error(lastErr || "no model configured");
    });

    const enrichment: Enrichment = { incidentId: p.incidentId, reason: p.reason, streamT: p.streamT, weather, places, history, brief, completedAt: Date.now() };

    await step.do("store", { retries: { limit: 3, delay: "1 second" }, timeout: "30 seconds" }, async () => {
      const inc = this.env.INCIDENT.get(this.env.INCIDENT.idFromName(p.incidentId));
      await inc.setEnrichment(enrichment, brief.status === "ok" ? brief.data : null);
      if (brief.status === "ok") {
        const hub = this.env.LIVE_HUB.get(this.env.LIVE_HUB.idFromName(p.stream));
        await hub.publish({ briefs: [{ id: p.incidentId, brief: brief.data }] });
      }
      return true;
    });
    return enrichment;
  }
}

function num(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? null : n;
}

function toWeather(source: Weather["source"], time: string, c: Record<string, number | string>): Weather {
  const dir = num(c.wind_direction_10m);
  return {
    source,
    time,
    windSpeedKmh: num(c.wind_speed_10m),
    windDirectionDeg: dir,
    windFrom: dir === null ? null : compass(dir),
    relativeHumidityPct: num(c.relative_humidity_2m),
    temperatureC: num(c.temperature_2m)
  };
}

/** Workers AI chat output comes either as { response } or OpenAI-style { choices[0].message.content }. */
export function extractText(out: unknown): string {
  if (!out || typeof out !== "object") return typeof out === "string" ? out : "";
  const o = out as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  if (typeof o.response === "string") return o.response;
  const c = o.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : "";
}
