import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { IncidentSummary } from "../incidentModel";
import type { Brief } from "../protocol";
import { compass, fetchPlaces, PLACES_RADIUS_KM, type Place, type PlacesSource } from "./places";
export type { Place } from "./places";
import { createAI, type CloudflareLanguageModelId } from "agents/models/ai-sdk";
import { generateText } from "ai";
import { briefModels, buildBriefPrompt, cleanBrief, DEFAULT_BRIEF_MAX_TOKENS } from "./brief";
import { OUTSIDE_COVERAGE } from "./history";

export interface EnrichParams {
  incidentId: string;
  stream: string;
  reason: "significant" | "area_grown";
  streamT: number;
  summary: IncidentSummary;
  /** Replays: a brief from the cache (no model call, no budget). */
  cachedBrief?: Brief;
  /** Replays: on a cache miss, store the new brief under this REPLAY_KV key. */
  briefCacheKey?: string;
  /** Replays: the scenario's brief cache is full, so no model call (see Clusterer.dispatchEnrichments). */
  skipBrief?: boolean;
}

type StepResult<T> = { status: "ok"; data: T } | { status: "failed"; error: string } | { status: "skipped"; reason: string; coverage?: number };

/** places: "ok" with an empty list = nothing within radiusKm; "failed" = lookup unavailable (error says why). */
export type PlacesResult =
  | { status: "ok"; data: Place[]; source: PlacesSource; radiusKm: number }
  | { status: "failed"; error: string; unavailable?: true }
  | { status: "skipped"; reason: string };

export interface Weather {
  source: "open-meteo-forecast" | "open-meteo-archive";
  time: string;
  windSpeedKmh: number | null;
  windDirectionDeg: number | null;
  windFrom: string | null;
  relativeHumidityPct: number | null;
  temperatureC: number | null;
}


export interface HistoryContext {
  dataSource: string;
  /** One readable sentence from api-worker GET /api/context (names the region). */
  summary: string;
}



export interface Enrichment {
  incidentId: string;
  reason: EnrichParams["reason"];
  streamT: number;
  weather: StepResult<Weather>;
  places: PlacesResult;
  history: StepResult<HistoryContext>;
  brief: StepResult<Brief>;
  completedAt: number;
}

const UA = "sensor-independent-fire-record-realtime/1.0 (NASA Space Apps 2026 demo; https://github.com/KrishJani/sensor-independent-fire-record)";


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

    // Never throws: a failure is recorded as { status: "failed", unavailable: true } so the UI can say
    // "unavailable" (lookup failed) rather than "none" (status ok, empty list within the radius).
    const places = (await safe<Place[]>("nearby-places", { retries: { limit: 1, delay: "3 seconds" }, timeout: "60 seconds" }, async () => {
      try {
        const { places: data, source } = await fetchPlaces(fetchJson, lat, lon);
        return { status: "ok", data, source, radiusKm: PLACES_RADIUS_KM } as StepResult<Place[]>;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.warn(JSON.stringify({ msg: "places_unavailable", incident: p.incidentId, error }));
        return { status: "failed", error, unavailable: true } as StepResult<Place[]>;
      }
    })) as PlacesResult;

    // Region-level context (api-worker GET /api/context): this region's activity this month against its
    // 2001-2025 median. Never the incident's own area: the per-cell archive is not loaded.
    const history = await safe<HistoryContext>("regional-context", { retries: { limit: 1, delay: "2 seconds" }, timeout: "20 seconds" }, async () => {
      if (!this.env.API) return { status: "skipped", reason: "no API service binding" };
      const date = new Date(p.streamT).toISOString().slice(0, 10);
      let res: Response;
      try {
        res = await this.env.API.fetch(`https://api-worker/api/context?lon=${lon}&lat=${lat}&date=${date}`);
      } catch (err) {
        return { status: "skipped", reason: `api-worker unavailable: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!res.ok) {
        const e = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        if (res.status >= 500 && res.status !== 503) throw new Error(`api-worker /api/context HTTP ${res.status}`);
        return { status: "skipped", reason: `regional context: ${e?.error?.code ?? `HTTP ${res.status}`}` };
      }
      const j = (await res.json()) as { available: boolean; reason?: string; text?: string };
      if (!j.available || !j.text) return { status: "skipped", reason: j.reason ?? OUTSIDE_COVERAGE };
      return { status: "ok", data: { dataSource: "live", summary: j.text } };
    });

    const brief = await safe<Brief>("brief", { retries: { limit: 1, delay: "5 seconds" }, timeout: "3 minutes" }, async () => {
      if (p.cachedBrief) {
        console.log(JSON.stringify({ msg: "brief_cache_hit", incident: p.incidentId }));
        return { status: "ok", data: { ...p.cachedBrief, text: cleanBrief(p.cachedBrief.text) || p.cachedBrief.text, cached: true } };
      }
      if (p.skipBrief) return { status: "skipped", reason: "replay brief cache is full; no new model calls" };
      const prompt = buildBriefPrompt({ summary: p.summary, stream: p.stream, weather, places, history });
      const [primary, ...fallbacks] = briefModels(this.env) as CloudflareLanguageModelId[];
      const maxTokens = Number(this.env.BRIEF_MAX_TOKENS) || DEFAULT_BRIEF_MAX_TOKENS;
      const ai = createAI({ binding: this.env.AI, id: this.env.AI_GATEWAY_ID });
      const [system, user] = prompt;
      const started = Date.now();
      try {
        // No temperature: Claude Haiku 5.5 rejects it. reasoningEffort null = reasoning off on the glm
        // fallback; Haiku ignores it and always thinks first (those tokens count against maxTokens).
        const res = await generateText({
          model: ai(primary, { fallback: fallbacks, reasoningEffort: null }),
          system: system.content,
          messages: [{ role: "user", content: user.content }],
          maxOutputTokens: maxTokens
        });
        const latencyMs = Date.now() - started;
        const model = res.response.modelId ?? primary;
        const text = cleanBrief(res.text);
        console.log(JSON.stringify({ msg: "brief_model_done", incident: p.incidentId, model, primary, latencyMs, ok: !!text, finishReason: res.finishReason, usage: res.usage ?? null }));
        if (!text) throw new Error(`${model}: empty response (${res.finishReason})`);
        const data: Brief = { text, model, generatedAt: Date.now(), streamT: p.streamT, asOf: new Date(p.streamT).toISOString(), affectedAreaKm2: p.summary.affectedAreaKm2, latencyMs };
        if (p.briefCacheKey) {
          try {
            await this.env.REPLAY_KV.put(p.briefCacheKey, JSON.stringify(data));
          } catch (err) {
            console.warn(JSON.stringify({ msg: "brief_cache_put_failed", key: p.briefCacheKey, error: String(err) }));
          }
        }
        return { status: "ok", data };
      } catch (err) {
        console.warn(JSON.stringify({ msg: "brief_model_failed", incident: p.incidentId, error: err instanceof Error ? err.message : String(err) }));
        throw err;
      }
    });

    const enrichment: Enrichment = { incidentId: p.incidentId, reason: p.reason, streamT: p.streamT, weather, places, history, brief, completedAt: Date.now() };

    await step.do("store", { retries: { limit: 3, delay: "1 second" }, timeout: "30 seconds" }, async () => {
      const inc = this.env.INCIDENT.get(this.env.INCIDENT.idFromName(p.incidentId));
      await inc.setEnrichment(enrichment, brief.status === "ok" ? brief.data : null, { streamT: p.streamT, affectedAreaKm2: p.summary.affectedAreaKm2, failed: brief.status === "failed" });
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

export function toWeather(source: Weather["source"], time: string, c: Record<string, number | string>): Weather {
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
