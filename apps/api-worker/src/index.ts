// nasa-fire-api: chat copilot (FireCopilotAgent, /agents/*), archival API (PlanetScale via Hyperdrive),
// realtime reads (D1). Spec: apps/api-worker/SPEC.md. Harmonization math: @repo/harmonizer.
//
// One deployment (wrangler.jsonc, account 7d56e968…) serves the copilot and the archival endpoints. A config
// without HYPERDRIVE + INGEST_STATE (e.g. a local chat-only setup) still works: the archival routes answer
// 503 archival_not_configured instead of failing.
import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { isAllowedOrigin, parseAllowedOrigins } from "./origins";
import { cachedJson, dataVersion } from "./lib/cache.ts";
import { closeDbs } from "./lib/db.ts";
import { ApiError, toHttp } from "./lib/http.ts";
import { calendar, calendarCsv, type CalendarRequest } from "./routes/calendar.ts";
import { health, meta } from "./routes/meta.ts";
import { prone, proneSummary } from "./routes/prone.ts";
import { realtimeSpots } from "./routes/realtime.ts";
import { spots } from "./routes/spots.ts";

export { FireCopilotAgent } from "./copilot/agent";

const allowed = (env: Env) => parseAllowedOrigins(env.ALLOWED_ORIGINS);
const DAY = 86400;

const app = new Hono<{ Bindings: Env }>();

app.use("*", (c, next) =>
  cors({
    origin: (origin) => (isAllowedOrigin(origin, allowed(c.env)) ? origin : null),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600
  })(c, next)
);

// Close per-request Postgres clients once the handler is done (also on errors).
app.use("/api/*", async (c, next) => {
  try { await next(); } finally { closeDbs(c.executionCtx); }
});

type ArchiveBindings = Partial<Pick<Env, "HYPERDRIVE" | "INGEST_STATE">>;
const hasArchive = (env: Env) => { const e = env as ArchiveBindings; return !!(e.HYPERDRIVE && e.INGEST_STATE); };

// Archival routes need Postgres (Hyperdrive) and the KV data version.
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path !== "/api/health" && !hasArchive(c.env))
    throw new ApiError(503, "archival_not_configured", "This deployment has no archival database (no HYPERDRIVE or INGEST_STATE binding).");
  await next();
});

app.onError((err, c) => {
  const { status, body } = toHttp(err);
  return c.json(body, status as 400);
});

app.get("/api/health", async (c) => {
  const chat = { model: c.env.CHAT_MODEL, dataSource: c.env.FIRE_DATA_SOURCE };
  if (!hasArchive(c.env)) return c.json({ ok: true, chat, archival: null });
  return c.json({ ...(await health(c.env, c.executionCtx)), chat });
});

app.get("/api/meta", async (c) => {
  const v = `${await dataVersion(c.env, "archival")}.${await dataVersion(c.env, "realtime")}`;
  return cachedJson(c.executionCtx, "meta", v, 60, () => meta(c.env, c.executionCtx));
});

// Realtime tier (D1): 15-min TTL, keyed by data:version:realtime (bumped by the ingest worker).
app.get("/api/realtime/spots", async (c) => {
  const q = new URL(c.req.url).searchParams;
  const key = `rt-spots|${[...q.entries()].sort().map(([k, v]) => `${k}=${v}`).join("&")}`;
  return cachedJson(c.executionCtx, key, await dataVersion(c.env, "realtime"), 900, () => realtimeSpots(c.env, q));
});

app.get("/api/archival/spots", async (c) => {
  const q = new URL(c.req.url).searchParams;
  const key = `spots|${[...q.entries()].sort().map(([k, v]) => `${k}=${v}`).join("&")}`;
  return cachedJson(c.executionCtx, key, await dataVersion(c.env, "archival"), DAY, () => spots(c.env, c.executionCtx, q));
});

app.post("/api/calendar", async (c) => {
  let body: CalendarRequest & { mode?: string };
  try { body = await c.req.json(); } catch { throw new ApiError(400, "body_invalid", "body must be JSON"); }
  if (body.mode && body.mode !== "archival") throw new ApiError(400, "mode_unsupported", 'only mode "archival" is served here so far');
  return cachedJson(c.executionCtx, `calendar|${JSON.stringify(body)}`, await dataVersion(c.env, "archival"), DAY, () => calendar(c.env, c.executionCtx, body));
});

app.get("/api/export/calendar.csv", async (c) => {
  const q = new URL(c.req.url).searchParams;
  const bbox = q.get("bbox")?.split(",").map(Number) as CalendarRequest["bbox"];
  const req: CalendarRequest = { scope: q.get("scope") ?? undefined, bbox: bbox ?? null, from: q.get("from") ?? undefined, to: q.get("to") ?? undefined };
  const body = await calendar(c.env, c.executionCtx, req);
  const name = `calendar_${req.scope ?? "aoi"}_${body.range.from}_${body.range.to}.csv`;
  return new Response(calendarCsv(body), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` } });
});

app.get("/api/prone", async (c) => {
  const q = new URL(c.req.url).searchParams;
  return cachedJson(c.executionCtx, `prone|${q.toString()}`, await dataVersion(c.env, "archival"), DAY, () => prone(c.env, c.executionCtx, q));
});
app.get("/api/prone/summary", async (c) => {
  const q = new URL(c.req.url).searchParams;
  return cachedJson(c.executionCtx, `prone-summary|${q.toString()}`, await dataVersion(c.env, "archival"), DAY, () => proneSummary(c.env, c.executionCtx, q));
});

// Chat copilot: WebSocket + HTTP at /agents/fire-copilot-agent/<sessionId>.
app.all("/agents/*", async (c) => {
  const origin = c.req.header("Origin");
  const allowOrigin = origin && isAllowedOrigin(origin, allowed(c.env)) ? origin : null;
  if (origin && !allowOrigin) return c.json({ error: { code: "forbidden_origin", message: "Origin not allowed" } }, 403);
  const res = await routeAgentRequest(c.req.raw, c.env, {
    cors: allowOrigin
      ? {
          "Access-Control-Allow-Origin": allowOrigin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          Vary: "Origin"
        }
      : undefined
  });
  return res ?? c.json({ error: { code: "not_found", message: "No such agent" } }, 404);
});

app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

export default app;
