import type { CompactRow } from "../detection";
import fallback from "./fallback-fixture.json";

/** Stored scenario (R2: scenarios/<id>.json). Rows are sorted by t. */
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

export function scenarioKey(id: string): string {
  return `scenarios/${id}.json`;
}

export interface LoadedScenario {
  scenario: Scenario;
  origin: "r2" | "bundled";
  note?: string;
}

/**
 * R2 first; if the object is missing (or R2 is unavailable locally) fall back to the bundled
 * California sample so `wrangler dev` works without any setup.
 */
export async function loadScenario(env: Env, id: string): Promise<LoadedScenario> {
  if (id !== FALLBACK_SCENARIO_ID) {
    try {
      const obj = await env.REPLAY_DATA.get(scenarioKey(id));
      if (obj) {
        const s = (await obj.json()) as Scenario;
        s.rows.sort((a, b) => a[0] - b[0]);
        return { scenario: s, origin: "r2" };
      }
    } catch (err) {
      console.warn(JSON.stringify({ msg: "scenario_r2_failed", id, error: String(err) }));
    }
  }
  const s = fallback as Scenario;
  return {
    scenario: s,
    origin: "bundled",
    note: id === FALLBACK_SCENARIO_ID ? undefined : `Scenario "${id}" not found in R2; playing the bundled fallback "${s.scenario}".`
  };
}
