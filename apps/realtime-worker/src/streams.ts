/** Stream naming. "live" (FIRMS NRT) or "replay:<id>" (a stored scenario played back). */

const STREAM_RE = /^(live|replay:[a-z0-9]{6,32})$/;

export function isStream(s: unknown): s is string {
  return typeof s === "string" && STREAM_RE.test(s);
}

export function replayStream(replayId: string): string {
  return `replay:${replayId}`;
}

/** Stream → prefix used in incident ids ("live", "replay-ab12cd34"). */
export function streamSlug(stream: string): string {
  return stream.replace(":", "-");
}

/** Incident ids are "<slug>.<seq>", e.g. "live.42" or "replay-ab12cd34.7". */
export function incidentId(stream: string, seq: number): string {
  return `${streamSlug(stream)}.${seq}`;
}

export function streamOfIncident(id: string): string | null {
  const dot = id.lastIndexOf(".");
  if (dot <= 0 || !/^\d+$/.test(id.slice(dot + 1))) return null;
  const slug = id.slice(0, dot);
  const stream = slug === "live" ? "live" : slug.startsWith("replay-") ? `replay:${slug.slice(7)}` : null;
  return stream && isStream(stream) ? stream : null;
}

export function dataSourceOf(stream: string): "live" | "replay" {
  return stream === "live" ? "live" : "replay";
}


/** Replays only enrich incidents at or above BRIEF_MIN_AREA_KM2 (live enriches on significance). */
export function briefMinAreaKm2(env: Pick<Env, "BRIEF_MIN_AREA_KM2">, stream: string): number {
  if (stream === "live") return 0;
  const v = Number(env.BRIEF_MIN_AREA_KM2 ?? 200);
  return Number.isFinite(v) && v >= 0 ? v : 200;
}
