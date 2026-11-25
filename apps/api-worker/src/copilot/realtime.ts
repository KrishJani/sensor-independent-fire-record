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
  'gridCoverageKm2 is the area of the 0.05° grid cells that contain detections. It overstates the burned area: call it "grid coverage", never "burned area" or "the fire covers"; lead with detections and cells, and give grid coverage as secondary. Refer to an incident by its place ("near Napoleonville") or coordinates, NEVER by an internal id. activity is active (detected < 12 h ago), cooling (12 to 36 h) or inactive (older): say "last detected N hours ago" rather than "burning" for cooling or inactive incidents. heat "persistent_heat" or "volcanic" means the heat is not a wildfire front: say so and do not call it a fire. Report the numbers as given: do not compute derived or normalized values (e.g. no FRP ratios), and quote peakFrp with its sensor label. Calendar caveats (cell-days, sourceMix, complete) do not apply to incidents.'; // host is ignored by service bindings

interface IncidentSummary {
  id: string;
  status: string;
  significant: boolean;
  mergedInto: string | null;
  detections: number;
  cells: number;
  affectedAreaKm2: number;
  frpMaxMw: number;
  frpMaxSensor?: string | null;
  firstSeen: number;
  lastSeen: number;
  centroid: [number, number];
  bbox: Bbox;
  growthKm2PerDay: number;
  sensors: Record<string, number>;
  activity?: string;
  frpTotalMw?: number;
  volcano?: { name: string } | null;
}

const coords = ([lon, lat]: [number, number]) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
const tidy = (s: string) => s.replace(/,(?:\s*,)+/g, ",");
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

type ListResponse = { streamT: number | null; count: number; incidents: IncidentSummary[] };
type PlacesStep = { status: string; data?: { name: string; place?: string; distanceKm: number; direction: string }[]; radiusKm?: number; error?: string };
type WeatherStep = { status: string; data?: { time?: string; windSpeedKmh: number | null; windFrom: string | null; relativeHumidityPct: number | null; temperatureC: number | null } };

/**
 * The stream comes from the map context when it has one: the model sometimes passes
 * stream "live" on its own, which during a replay answered about live fires elsewhere and
 * produced "no fires". args.stream is only used when the map shows no stream.
 */
export function resolveStream(argStream: string | undefined, ctx: MapContext | null): { stream: string; ignored: string | null } {
  const fromCtx = ctx?.realtimeStream;
  if (fromCtx) return { stream: fromCtx, ignored: argStream && argStream !== fromCtx ? argStream : null };
  return { stream: argStream ?? "live", ignored: null };
}

/** Nearest places for the tool output: names, "none within N km", or "unavailable (...)". */
export function describePlaces(places: PlacesStep | undefined | null): string[] | string | null {
  if (!places) return null;
  if (places.status === "ok") {
    if (places.data?.length) return places.data.slice(0, 3).map((p) => `${p.name} (${p.place ? `${p.place}, ` : ""}${p.distanceKm} km ${p.direction})`);
    return `none within ${places.radiusKm ?? 30} km`;
  }
  if (places.status === "failed") return "unavailable (the place lookup failed; say it is unavailable, not that there are no towns)";
  return null;
}

export async function getLiveIncidents(rt: RealtimeFetcher, args: LiveIncidentsArgs, ctx: MapContext | null) {
  const { stream, ignored } = resolveStream(args.stream, ctx);
  if (!STREAM_RE.test(stream)) return { error: "bad_stream", message: 'stream must be "live" or "replay:<id>"' };
  const bbox = args.bbox ?? ctx?.aoi?.bbox ?? null;
  const dataSource = stream === "live" ? "live" : "replay";

  let replay: { scenario: string; status: string; progress: number; clock: string | null } | null = null;
  if (stream !== "live") {
    const r = await getJson<{ scenario: string; status: string; progress: number; streamT: number }>(rt, `/realtime/replay/${stream.slice(7)}`);
    if (!r.ok) return { error: "no_such_replay", message: `Replay ${stream} was not found (HTTP ${r.status}).` };
    replay = { scenario: r.data.scenario, status: r.data.status, progress: round(r.data.progress), clock: iso(r.data.streamT) };
  }

  const status = args.status ?? "active";
  const list = (q: { status: string; bbox: Bbox | null; limit: number }) => {
    const qs = new URLSearchParams({ stream, status: q.status, limit: String(q.limit) });
    if (q.bbox) qs.set("bbox", q.bbox.join(","));
    return getJson<ListResponse>(rt, `/realtime/incidents?${qs}`);
  };
  const r = await list({ status, bbox, limit: Math.min(args.limit ?? 10, 25) });
  if (!r.ok) return { error: "realtime_unavailable", message: `Realtime service error (HTTP ${r.status}).` };

  const heatOf = (s: IncidentSummary) =>
    s.volcano ? "volcanic" : s.frpTotalMw !== undefined && s.cells > 0 && s.detections / s.cells >= 30 && s.frpTotalMw / s.detections < 20 ? "persistent_heat" : "wildfire";
  const ids: string[] = r.data.incidents.map((s) => s.id); // internal: used for detail calls only, never returned
  const incidents = r.data.incidents.map((s) => ({
    location: coords(s.centroid),
    ...(s.volcano ? { volcano: s.volcano.name } : {}),
    heat: heatOf(s),
    activity: s.activity ?? s.status,
    detections: s.detections,
    gridCells: s.cells,
    gridCoverageKm2: s.affectedAreaKm2,
    newGridCoverageKm2Last24h: s.growthKm2PerDay,
    peakFrp: `${s.frpMaxMw} MW (${s.frpMaxSensor ?? "sensor not recorded"})`,
    detectionsBySensor: s.sensors,
    firstSeen: iso(s.firstSeen),
    lastSeen: iso(s.lastSeen),
    centroid: { lat: round(s.centroid[1], 3), lon: round(s.centroid[0], 3) }
  }));

  // Briefs, nearest places and weather for the 3 largest incidents (one detail call each).
  const details = await Promise.all(
    ids.slice(0, 3).map((id) =>
      getJson<{ brief: { text: string; asOf?: string } | null; weatherNow?: NonNullable<WeatherStep["data"]> | null; enrichment: { places?: PlacesStep; weather?: WeatherStep; streamT?: number } | null }>(
        rt,
        `/realtime/incidents/${encodeURIComponent(id)}`
      ).catch(() => null)
    )
  );
  details.forEach((d, idx) => {
    if (!d?.ok) return;
    const target = incidents[idx] as Record<string, unknown>;
    if (d.data.brief?.text) {
      target.brief = tidy(d.data.brief.text);
      if (d.data.brief.asOf) target.briefAsOf = d.data.brief.asOf;
    }
    const places = describePlaces(d.data.enrichment?.places);
    if (places) {
      target.nearestPlaces = places;
      const first = Array.isArray(places) ? places[0]?.replace(/ \(.*$/, "") : null;
      if (first) target.name = `near ${first}`;
    }
    // The same current reading the incident card shows (live); the stored enrichment reading otherwise.
    const now = d.data.weatherNow;
    const w = d.data.enrichment?.weather;
    if (now)
      target.weather = { time: now.time ?? null, windKmh: now.windSpeedKmh, windFrom: now.windFrom, relativeHumidityPct: now.relativeHumidityPct, temperatureC: now.temperatureC, note: "current reading, same as the incident card" };
    else if (w?.status === "ok" && w.data)
      target.weather = {
        time: w.data.time ?? null,
        windKmh: w.data.windSpeedKmh,
        windFrom: w.data.windFrom,
        relativeHumidityPct: w.data.relativeHumidityPct,
        temperatureC: w.data.temperatureC
      };
    else if (w) target.weather = "unavailable";
  });

  // Empty result: say why, so the answer is "nothing detected here yet as of <time>", never "no fires".
  let empty: Record<string, unknown> = {};
  if (incidents.length === 0) {
    const clock = replay?.clock ?? iso(r.data.streamT);
    const [anyStatus, anyArea] = await Promise.all([
      status !== "all" ? list({ status: "all", bbox, limit: 1 }) : null,
      bbox ? list({ status: "all", bbox: null, limit: 1 }) : null
    ]);
    const inactiveHere = anyStatus?.ok ? anyStatus.data.count : 0;
    const elsewhere = anyArea?.ok ? anyArea.data.count : 0;
    const reason =
      r.data.streamT === null ? "stream_not_started" : inactiveHere > 0 ? "only_inactive" : bbox && elsewhere > 0 ? "outside_area" : "none_detected_yet";
    const where = bbox ? "in this area" : "in this stream";
    empty = {
      emptyReason: reason,
      ...(bbox ? { incidentsOutsideThisArea: elsewhere } : {}),
      ...(inactiveHere ? { inactiveIncidentsHere: inactiveHere } : {}),
      answerHint:
        (replay
          ? `Replay clock ${clock ?? "not started"} (${Math.round((replay.progress ?? 0) * 100)}% through the scenario). `
          : `As of ${clock ?? "the latest poll"}. `) +
        (reason === "stream_not_started"
          ? "The stream has no detections yet. Say nothing has been detected yet and give the clock time."
          : reason === "only_inactive"
            ? `No active incidents ${where}, but ${inactiveHere} inactive one(s): call again with status "all" to describe them.`
            : reason === "outside_area"
              ? `No significant incidents ${where} yet; there are incidents elsewhere in the stream (call again without bbox to see them).`
              : `No significant incident has been detected ${where} yet.`) +
        ' Do not say "there are no fires": satellites miss fires and incidents need several detections to count.'
    };
  }

  return {
    dataSource,
    stream,
    ...(replay ? { replay } : {}),
    note:
      dataSource === "live"
        ? `Incidents are clusters of real NASA FIRMS near-real-time detections (VIIRS + MODIS) on a 0.05° grid. ${INCIDENT_RULES}`
        : `REPLAY of a stored historical scenario (${replay?.scenario}), not current activity: real archived NASA FIRMS detections played back. Times are the original detection times; use the past tense and say it is a replay. ${INCIDENT_RULES}`,
    streamTime: iso(r.data.streamT),
    ...(ignored ? { streamNote: `Used the map's stream ${stream}; the requested stream "${ignored}" was ignored.` } : {}),
    bbox,
    count: r.data.count,
    ...empty,
    incidents
  };
}

export function createRealtimeTools(rt: RealtimeFetcher | undefined, getContext: () => MapContext | null): ToolSet {
  if (!rt) return {};
  return {
    get_live_incidents: tool({
      description:
        "Current fire INCIDENTS (clusters of real NASA FIRMS detections) from the realtime pipeline: affected area in km² (0.05° cells with detections, larger than the burned area), growth over the last 24 h, detections, peak FRP, first/last seen, plus for the 3 largest an AI brief, nearest populated places and the weather. Use for 'what is burning now', 'biggest fire', 'how fast is it growing', 'which towns are near', 'what is the wind doing', 'how did the fires develop'. Uses the map's stream (live or the replay on screen) and area automatically: do not pass stream unless the map shows none.",
      inputSchema: z.object({
        stream: z.string().regex(STREAM_RE).optional().describe("Leave out: the map's stream is used. Only used when the map shows no stream."),
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
