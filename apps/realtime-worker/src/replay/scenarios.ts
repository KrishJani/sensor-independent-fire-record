import type { CompactRow } from "../detection";
import fallback from "./fallback-fixture.json";

/** Stored scenario (R2 scenarios/<id>.json, or gzipped in KV scenarios/<id>.json.gz). Rows are sorted by t. */
export interface Scenario {
  scenario: string;
  label: string;
  bbox: [number, number, number, number];
  from: string;
  to: string;
  sources: string[];
  generatedAt?: string;
  /** [t, lat, lon, satIdx, frp, confIdx, day] — see detection.ts toCompact(). */
  rows: CompactRow[];
}

export const FALLBACK_SCENARIO_ID = (fallback as Scenario).scenario;
export const KNOWN_SCENARIOS = ["quebec-2023-06", FALLBACK_SCENARIO_ID];

/** R2 object key. */
export function scenarioKey(id: string): string {
  return `scenarios/${id}.json`;
}
/** KV key: the same JSON, gzip-compressed (Quebec: 2.7 MB → 0.53 MB, far below KV's 25 MiB limit). */
export function scenarioKvKey(id: string): string {
  return `scenarios/${id}.json.gz`;
}

/** REPLAY_DATA is optional: the r2_buckets entry is commented out until the bucket exists. */
export function replayBucket(env: Env): R2Bucket | null {
  return (env as Env & { REPLAY_DATA?: R2Bucket }).REPLAY_DATA ?? null;
}

export type ScenarioOrigin = "r2" | "kv" | "bundled";

export interface LoadedScenario {
  scenario: Scenario;
  origin: ScenarioOrigin;
  note?: string;
}

export async function gunzipJson<T>(body: ReadableStream | ArrayBuffer): Promise<T> {
  const stream = body instanceof ReadableStream ? body : new Response(body).body!;
  return new Response(stream.pipeThrough(new DecompressionStream("gzip"))).json() as Promise<T>;
}

/**
 * R2 (REPLAY_DATA) if bound, otherwise KV (REPLAY_KV, gzipped). If the scenario is in neither,
 * fall back to the bundled California sample so `wrangler dev` works without any setup.
 */
export async function loadScenario(env: Env, id: string): Promise<LoadedScenario> {
  if (id !== FALLBACK_SCENARIO_ID) {
    const found = await loadStored(env, id);
    if (found) {
      found.scenario.rows.sort((a, b) => a[0] - b[0]);
      return found;
    }
  }
  const s = fallback as Scenario;
  const where = replayBucket(env) ? "R2" : "KV";
  return {
    scenario: s,
    origin: "bundled",
    note: id === FALLBACK_SCENARIO_ID ? undefined : `Scenario "${id}" not found in ${where}; playing the bundled fallback "${s.scenario}".`
  };
}

async function loadStored(env: Env, id: string): Promise<LoadedScenario | null> {
  const bucket = replayBucket(env);
  if (bucket) {
    try {
      const obj = await bucket.get(scenarioKey(id));
      if (obj) return { scenario: (await obj.json()) as Scenario, origin: "r2" };
    } catch (err) {
      console.warn(JSON.stringify({ msg: "scenario_r2_failed", id, error: String(err) }));
    }
  }
  try {
    const body = await env.REPLAY_KV.get(scenarioKvKey(id), "stream");
    if (body) return { scenario: await gunzipJson<Scenario>(body), origin: "kv" };
  } catch (err) {
    console.warn(JSON.stringify({ msg: "scenario_kv_failed", id, error: String(err) }));
  }
  return null;
}
