import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { BboxSchema, type Bbox, type MapContext } from "./context";

/**
 * get_live_incidents: fire incidents from apps/realtime-worker over the REALTIME service binding.
 * Incidents are clusters of real NASA FIRMS detections. Stream "live" = near-real-time polling;
 * "replay:<id>" = a stored historical scenario being played back (labelled dataSource "replay").
 */

export const STREAM_RE = /^(live|replay:[a-z0-9]{6,32})$/;

/** Minimal fetcher so tests can pass a fake binding. */
export interface RealtimeFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

const ORIGIN = "https://realtime-worker";

const INCIDENT_RULES =
  "areaKm2 is the area of active grid cells, not a burned-area perimeter. Report the numbers as given: do not compute derived or normalized values (e.g. no FRP ratios), and quote peakFrp with its sensor label. Calendar caveats (cell-days, sourceMix, complete) do not apply to incidents."; // host is ignored by service bindings

interface IncidentSummary {
  id: string;
  status: string;
  significant: boolean;
  mergedInto: string | null;
  detections: number;
  cells: number;
  areaKm2: number;
  frpMaxMw: number;
  frpMaxSensor?: string | null;
  firstSeen: number;
  lastSeen: number;
  centroid: [number, number];
  bbox: Bbox;
  growthKm2PerDay: number;
  sensors: Record<string, number>;
}

const iso = (t: number | null | undefined) => (typeof t === "number" ? new Date(t).toISOString().slice(0, 16) + "Z" : null);
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

async function getJson<T>(rt: RealtimeFetcher, path: string): Promise<{ ok: true; data: T } | { ok: false; status: number; body: string }> {
  const res = await rt.fetch(`${ORIGIN}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) return { ok: false, status: res.status, body: (await res.text()).slice(0, 300) };
  return { ok: true, data: (await res.json()) as T };
}

export interface LiveIncidentsArgs {
  stream?: string;
  bbox?: Bbox;
  status?: "active" | "inactive" | "all";
  limit?: number;
}

export async function getLiveIncidents(rt: RealtimeFetcher, args: LiveIncidentsArgs, ctx: MapContext | null) {
  const stream = args.stream ?? ctx?.realtimeStream ?? "live";
  if (!STREAM_RE.test(stream)) return { error: "bad_stream", message: 'stream must be "live" or "replay:<id>"' };
  const bbox = args.bbox ?? ctx?.aoi?.bbox ?? null;
  const dataSource = stream === "live" ? "live" : "replay";

  let replay: { scenario: string; status: string; progress: number } | null = null;
  if (stream !== "live") {
    const r = await getJson<{ scenario: string; status: string; progress: number }>(rt, `/realtime/replay/${stream.slice(7)}`);
    if (!r.ok) return { error: "no_such_replay", message: `Replay ${stream} was not found (HTTP ${r.status}).` };
    replay = { scenario: r.data.scenario, status: r.data.status, progress: round(r.data.progress) };
  }

  const qs = new URLSearchParams({ stream, status: args.status ?? "active", limit: String(Math.min(args.limit ?? 10, 25)) });
  if (bbox) qs.set("bbox", bbox.join(","));
  const r = await getJson<{ streamT: number | null; count: number; incidents: IncidentSummary[] }>(rt, `/realtime/incidents?${qs}`);
  if (!r.ok) return { error: "realtime_unavailable", message: `Realtime service error (HTTP ${r.status}).` };

  const incidents = r.data.incidents.map((s) => ({
    id: s.id,
    status: s.status,
    areaKm2: s.areaKm2,
    growthKm2PerDayLast24h: s.growthKm2PerDay,
    detections: s.detections,
    activeCells: s.cells,
    peakFrp: `${s.frpMaxMw} MW (${s.frpMaxSensor ?? "sensor not recorded"})`,
    detectionsBySensor: s.sensors,
    firstSeen: iso(s.firstSeen),
    lastSeen: iso(s.lastSeen),
    centroid: { lat: round(s.centroid[1], 3), lon: round(s.centroid[0], 3) },
    ...(s.mergedInto ? { mergedInto: s.mergedInto } : {})
  }));

  // Briefs + nearest towns for the 3 largest incidents (one detail call each).
  const details = await Promise.all(
    incidents.slice(0, 3).map((i) =>
      getJson<{ brief: { text: string } | null; enrichment: { places?: { status: string; data?: { name: string; distanceKm: number; direction: string }[] } } | null }>(
        rt,
        `/realtime/incidents/${encodeURIComponent(i.id)}`
      ).catch(() => null)
    )
  );
  details.forEach((d, idx) => {
    if (!d?.ok) return;
    const target = incidents[idx] as Record<string, unknown>;
    if (d.data.brief?.text) target.brief = d.data.brief.text;
    const places = d.data.enrichment?.places;
    if (places?.status === "ok" && places.data?.length)
      target.nearestTowns = places.data.slice(0, 3).map((p) => `${p.name} (${p.distanceKm} km ${p.direction})`);
  });

  return {
    dataSource,
    stream,
    ...(replay ? { replay } : {}),
    note:
      dataSource === "live"
        ? `Incidents are clusters of real NASA FIRMS near-real-time detections (VIIRS + MODIS) on a 0.05° grid. ${INCIDENT_RULES}`
        : `REPLAY of a stored historical scenario (${replay?.scenario}), not current activity: real archived NASA FIRMS detections played back. Times are the original detection times; use the past tense and say it is a replay. ${INCIDENT_RULES}`,
    streamTime: iso(r.data.streamT),
    bbox,
    count: r.data.count,
    incidents
  };
}

export function createRealtimeTools(rt: RealtimeFetcher | undefined, getContext: () => MapContext | null): ToolSet {
  if (!rt) return {};
  return {
    get_live_incidents: tool({
      description:
        "Current fire INCIDENTS (clusters of real NASA FIRMS detections) from the realtime pipeline: size in km² of active 0.05° cells, growth over the last 24 h, detections, peak FRP, first/last seen, and an AI brief and nearest towns when available. Use for 'what is burning now', 'active fires/incidents here', 'how fast is it growing'. Defaults to the map's area and the live stream; pass stream 'replay:<id>' (or rely on the map context) for a historical replay.",
      inputSchema: z.object({
        stream: z.string().regex(STREAM_RE).optional().describe('"live" (default) or "replay:<id>" for an active replay. Omit to use the map context.'),
        bbox: BboxSchema.optional().describe("[west, south, east, north]. Omit to use the area selected on the map (no area = whole stream)."),
        status: z.enum(["active", "inactive", "all"]).optional().describe("Default active."),
        limit: z.number().int().min(1).max(25).optional().describe("Max incidents, largest first. Default 10.")
      }),
      execute: async (args: LiveIncidentsArgs) => {
        try {
          return await getLiveIncidents(rt, args, getContext());
        } catch (err) {
          console.error("[copilot] get_live_incidents failed:", err);
          return { error: "realtime_unavailable", message: err instanceof Error ? err.message : String(err) };
        }
      }
    })
  };
}
