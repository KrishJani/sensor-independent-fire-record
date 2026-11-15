import { Hono } from "hono";
import { cors } from "hono/cors";
import { parseBbox } from "./grid";
import { consumeDetections, NRT_SOURCES, pollOnce, watchBboxes, type DetectionsMessage, type PollState } from "./live/poll";
import type { IncidentDetail } from "./do/incident";
import type { IncidentStatus } from "./incidentModel";
import { KNOWN_SCENARIOS } from "./replay/scenarios";
import { isStream, streamOfIncident } from "./streams";

export { Clusterer } from "./do/clusterer";
export { Incident } from "./do/incident";
export { LiveHub } from "./do/liveHub";
export { Replay } from "./do/replay";

const allowedOrigins = (env: Env) =>
  (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

const err = (code: string, message: string) => ({ error: { code, message } });

const app = new Hono<{ Bindings: Env }>();

app.use("*", (c, next) =>
  cors({
    origin: (origin) => (allowedOrigins(c.env).includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600
  })(c, next)
);

const clusterer = (env: Env, stream: string) => env.CLUSTERER.get(env.CLUSTERER.idFromName(stream));
const hub = (env: Env, stream: string) => env.LIVE_HUB.get(env.LIVE_HUB.idFromName(stream));
const replay = (env: Env, id: string) => env.REPLAY.get(env.REPLAY.idFromName(id));

app.get("/realtime/health", async (c) => {
  const live = await clusterer(c.env, "live").stats();
  const poll: Record<string, PollState | null> = {};
  for (const bbox of watchBboxes(c.env))
    for (const source of NRT_SOURCES)
      poll[`${source}:${bbox.join(",")}`] = await c.env.INGEST_STATE.get<PollState>(`realtime:poll:${source}:${bbox.join(",")}`, "json");
  return c.json({ ok: true, live, poll, scenarios: KNOWN_SCENARIOS });
});

app.get("/realtime/incidents", async (c) => {
  const stream = c.req.query("stream") ?? "live";
  if (!isStream(stream)) return c.json(err("bad_stream", 'stream must be "live" or "replay:<id>"'), 400);
  const bboxRaw = c.req.query("bbox");
  const bbox = parseBbox(bboxRaw);
  if (bboxRaw && !bbox) return c.json(err("bad_bbox", "bbox must be w,s,e,n in degrees"), 400);
  const status = (c.req.query("status") ?? "all") as IncidentStatus | "all";
  if (!["active", "inactive", "merged", "all"].includes(status)) return c.json(err("bad_status", "status must be active, inactive, merged or all"), 400);
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 200) || 200));
  const res = await clusterer(c.env, stream).list({ bbox, status, limit, includeMinor: c.req.query("minor") === "1" });
  return c.json({ ...res, stream, dataSource: stream === "live" ? "live" : "replay", count: res.incidents.length });
});

app.get("/realtime/incidents/:id", async (c) => {
  const id = c.req.param("id");
  const stream = streamOfIncident(id);
  if (!stream) return c.json(err("bad_id", "unknown incident id format"), 400);
  const streamT = await clusterer(c.env, stream).getStreamT();
  const detail = (await c.env.INCIDENT.get(c.env.INCIDENT.idFromName(id)).detail(streamT)) as IncidentDetail | null;
  if (!detail) return c.json(err("not_found", "no such incident"), 404);
  return c.json({ ...detail, stream, streamT, dataSource: stream === "live" ? "live" : "replay" });
});

// ---- Replay -----------------------------------------------------------------

app.post("/realtime/replay", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { scenario?: string; speed?: number };
  const scenario = body.scenario ?? "quebec-2023-06";
  if (!/^[a-z0-9-]{3,64}$/.test(scenario)) return c.json(err("bad_scenario", "invalid scenario id"), 400);
  const speed = Number(body.speed ?? c.env.REPLAY_DEFAULT_SPEED ?? 12000);
  if (!Number.isFinite(speed) || speed < 1 || speed > 1_000_000) return c.json(err("bad_speed", "speed must be 1..1000000 (stream seconds per real second)"), 400);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  try {
    const info = await replay(c.env, id).start({ id, scenario, speed });
    return c.json(info, 201);
  } catch (e) {
    return c.json(err("replay_failed", e instanceof Error ? e.message : String(e)), 500);
  }
});

app.get("/realtime/replay/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-z0-9]{6,32}$/.test(id)) return c.json(err("bad_id", "invalid replay id"), 400);
  const info = await replay(c.env, id).status();
  if (!info) return c.json(err("not_found", "no such replay"), 404);
  const stats = await clusterer(c.env, info.stream).stats();
  return c.json({ ...info, clusterer: stats });
});

for (const action of ["pause", "resume", "stop"] as const) {
  app.post(`/realtime/replay/:id/${action}`, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-z0-9]{6,32}$/.test(id)) return c.json(err("bad_id", "invalid replay id"), 400);
    const info = await replay(c.env, id)[action]();
    if (!info) return c.json(err("not_found", "no such replay"), 404);
    return c.json(info);
  });
}

// ---- WebSocket ----------------------------------------------------------------

app.get("/realtime/ws", async (c) => {
  const origin = c.req.header("Origin");
  if (origin && !allowedOrigins(c.env).includes(origin)) return c.json(err("forbidden_origin", "Origin not allowed"), 403);
  const stream = c.req.query("stream") ?? "live";
  if (!isStream(stream)) return c.json(err("bad_stream", 'stream must be "live" or "replay:<id>"'), 400);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json(err("upgrade_required", "Use a WebSocket"), 426);
  return hub(c.env, stream).fetch(c.req.raw);
});

app.notFound((c) => c.json(err("not_found", "Not found"), 404));

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      pollOnce(env).then(
        (r) => console.log(JSON.stringify({ job: "realtime_poll_done", sources: r.length, queued: r.reduce((a, x) => a + x.queued, 0) })),
        (e) => console.error(JSON.stringify({ job: "realtime_poll_failed", error: String(e) }))
      )
    );
  },
  async queue(batch, env) {
    await consumeDetections(batch as MessageBatch<DetectionsMessage>, env);
  }
} satisfies ExportedHandler<Env, DetectionsMessage>;

