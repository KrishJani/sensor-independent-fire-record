# Realtime pipeline (`realtime-worker`)

This worker turns NASA FIRMS hotspots into **fire incidents** and streams them to the map over a WebSocket. It handles two kinds of input stream, and everything downstream of the input is the same for both:

| Stream | Input | Use |
|---|---|---|
| `live` | FIRMS NRT polled every 10 min (VIIRS S-NPP, NOAA-20, NOAA-21, MODIS) | The Realtime tab |
| `replay:<id>` | A stored historical scenario played back fast (default: Quebec, 1–10 June 2023, in about 75 s) | Demos, and development without live fires |

Streams never mix. All time logic (the active window, growth, inactive status) uses **detection time** (`acq_date` + `acq_time`, UTC), so a replay behaves exactly like live. "Now" for a stream is its **stream time**: the latest detection time it has seen.

Base URL in dev: `http://localhost:8789`. Every route is under `/realtime/*`.

---

## 1. What an incident is

- Each detection goes into a 0.05° grid cell (about 5.5 km).
- A detection joins an incident when any of the 9 cells around it belongs to an incident seen within the last **48 h of stream time**. Otherwise it starts a new incident.
- When a detection touches two incidents, the older one wins and the other gets `status: "merged"` and `mergedInto`. The cells are not combined.
- Low-confidence detections (VIIRS `l`, MODIS below 30) are counted and drawn on the heat layer, but they never create or grow an incident.
- An incident is **significant** at 5 or more detections across 2 or more cells. Only significant incidents are pushed to clients, listed by REST and enriched.
- `status` is `active`, `inactive` (no detections for 48 h of stream time) or `merged`.
- `affectedAreaKm2` is the summed area of the 0.05° grid cells that contain at least one detection (each cell is about 30 km² at the equator and shrinks with cos(lat)). A single hotspot marks a whole cell, so this **overstates the burned area**, often by a lot. It is not a perimeter. Label it "area with detections" in the UI, never "burned area".

### `IncidentSummary`

```ts
{
  id: string;                 // "live.42" or "replay-ab12cd34ef.7"
  stream: string;             // "live" | "replay:<id>"
  status: "active" | "inactive" | "merged";
  significant: boolean;
  mergedInto: string | null;
  detections: number;         // non-low-confidence detections
  cells: number;              // 0.05° cells with detections
  affectedAreaKm2: number;    // area of those cells; overstates burned area (see above)
  frpTotalMw: number;
  frpMaxMw: number;
  frpMaxSensor: "VIIRS" | "MODIS" | null;   // FRP is not harmonized: always show the sensor
  firstSeen: number;          // epoch ms (UTC detection time)
  lastSeen: number;
  centroid: [lon, lat];
  bbox: [w, s, e, n];
  growthKm2PerDay: number;    // affected area of cells first seen in the last 24 h of stream time
  sensors: { VIIRS: number; MODIS: number };
  asOf: number;               // stream time this summary was computed at
}
```

---

## 2. WebSocket: `GET /realtime/ws?stream=live|replay:<id>[&bbox=w,s,e,n]`

The socket is hibernatable and lives in the `LiveHub` Durable Object (one per stream). `Origin` must be listed in `ALLOWED_ORIGINS`; other origins get 403.

### Frames

Every frame is JSON. A frame is either **one message** or a **batch**:

```ts
{ type: "batch", messages: ServerMessage[] }
```

Always unwrap batches first. The server coalesces updates and sends at most one frame per client every 500 ms. Each frame holds at most one `clock`, one `detections` and one `incident.upsert` per changed incident (only the latest version).

### Server → client

| `type` | Shape | When |
|---|---|---|
| `hello` | `{ stream, streamT: number \| null, incidents: number }` | First message after connecting (inside the snapshot batch) |
| `incident.upsert` | `{ incident: IncidentSummary }` | A significant incident changed. Replace by `incident.id`. |
| `incident.brief` | `{ id, brief: Brief }` (below) | An AI brief is ready, or was refreshed after the area doubled |
| `detections` | `{ points: [lon, lat, frpMw, tMs, conf][], replace?: true }` | New detections inside your viewport. `conf` is 0 (low), 1 (nominal) or 2 (high). With `replace: true`, the points replace your heat layer (on connect and after a viewport change); otherwise append them. |
| `clock` | `{ t: number }` | Replay only: stream time advanced (each tick, about 2/s) |
| `replay.status` | `{ status: "running" \| "paused" \| "stopped" \| "done", progress: 0..1 }` | Replay only |
| `error` | `{ message }` | A bad client message |

`Brief`:

```ts
{
  text: string;        // 2 or 3 sentences; says "area with detections", never "burned area"
  model: string;
  generatedAt: number; // wall clock, epoch ms
  streamT: number;     // stream time the brief describes, epoch ms
  asOf: string;        // the same moment as ISO 8601 UTC: show "as of <asOf>" next to the text
  latencyMs?: number;  // model call duration
  cached?: boolean;    // replays: reused from an earlier replay of the same scenario (see brief cache)
}
```

On connect you get one snapshot batch containing `hello`, the current `clock` (replay), every known significant incident (`incident.upsert`), their briefs, and recent detections (last 48 h of stream time, up to 5000, filtered by `bbox` when you passed one).

### Client → server

```ts
{ type: "viewport", bbox: [w, s, e, n] | null }   // null = everything
{ type: "ping" }                                   // → { type: "pong" }
```

After a `viewport` message the server replies with `detections` (`replace: true`) for the new box, and filters later `detections` to it. Incident upserts are **not** filtered by viewport, so the incident list stays complete.

### Frontend usage

```ts
const REALTIME_BASE = import.meta.env.VITE_REALTIME_BASE; // e.g. "http://localhost:8789"

function connectRealtime(stream: string, map: mapboxgl.Map, handlers: {
  onIncident(i: IncidentSummary): void;
  onBrief(id: string, brief: { text: string }): void;
  onPoints(points: [number, number, number, number, number][], replace: boolean): void;
  onClock?(t: number): void;
  onReplayStatus?(s: { status: string; progress: number }): void;
}) {
  const wsUrl = REALTIME_BASE.replace(/^http/, "ws") + `/realtime/ws?stream=${encodeURIComponent(stream)}`;
  let ws: WebSocket;
  let closed = false;

  const sendViewport = () => {
    const b = map.getBounds();
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "viewport", bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] }));
  };

  const handle = (m: any) => {
    switch (m.type) {
      case "batch": m.messages.forEach(handle); break;
      case "incident.upsert": handlers.onIncident(m.incident); break;
      case "incident.brief": handlers.onBrief(m.id, m.brief); break;
      case "detections": handlers.onPoints(m.points, !!m.replace); break;
      case "clock": handlers.onClock?.(m.t); break;
      case "replay.status": handlers.onReplayStatus?.(m); break;
    }
  };

  const open = () => {
    ws = new WebSocket(wsUrl);
    ws.onopen = sendViewport;
    ws.onmessage = (ev) => handle(JSON.parse(ev.data));
    ws.onclose = () => { if (!closed) setTimeout(open, 2000); };   // simple reconnect; the snapshot restores state
  };
  open();
  let t: ReturnType<typeof setTimeout>;
  const onMove = () => { clearTimeout(t); t = setTimeout(sendViewport, 250); };
  map.on("moveend", onMove);
  return () => { closed = true; map.off("moveend", onMove); ws.close(); };
}
```

Map layers:
- **Heat layer:** keep a `Map` or array of points. Convert them to a GeoJSON source of `Point` features with properties `{ frp, t, conf }`. Use a Mapbox `heatmap` layer weighted by `frp`, and optionally fade by `streamT - t`. Drop points older than 48 h of stream time.
- **Incidents:** keep a `Map<id, IncidentSummary>`. Draw `centroid` as a circle sized by `affectedAreaKm2`, or draw `bbox` as an outline. Hide `status: "merged"` and dim `inactive`.
- **Clock (replay):** show `new Date(t).toISOString()` as "Replay time". For live, use `max(lastSeen)`, or `streamT` from `/realtime/incidents`.

---

## 3. REST

All responses are JSON. Errors are `{ error: { code, message } }` with status 400, 404 or 500. CORS is limited to `ALLOWED_ORIGINS`.

| Method and path | Purpose |
|---|---|
| `GET /realtime/health` | `{ ok, live: { streamT, counters, incidents, merges, enrich }, poll: { "<SOURCE>:<bbox>": PollState }, scenarios, briefBudget: { used, max, windowHours }, activeReplay: { id, scenario } \| null }` |
| `GET /realtime/incidents?stream=live&bbox=w,s,e,n&status=active\|inactive\|merged\|all&limit=200` | `{ stream, streamT, dataSource: "live"\|"replay", count, incidents: IncidentSummary[] }`, sorted by `affectedAreaKm2` (largest first). Only significant incidents (`&minor=1` includes all). `bbox` intersects the incident bbox. Default status is `all`. |
| `GET /realtime/incidents/:id` | `{ summary, timeline, enrichments, enrichment, brief, stream, streamT, dataSource }`. `timeline` is hourly: `[{ hour, detections, newCells, frp, affectedAreaKm2 }]` (cumulative). `enrichment` is described below. |
| `POST /realtime/replay` body `{ scenario?: "quebec-2023-06", speed?: number }` | Starts a replay and returns `ReplayInfo` with `reused: false` (201). Only **one replay runs at a time** across the whole worker: if one is already running (or paused) for the same scenario, you get that one back with `reused: true` (200) and `speed` is ignored; if a different scenario is running you get 409 `replay_busy`. `speed` is stream seconds per real second; the default `REPLAY_DEFAULT_SPEED` is 12000, so 10 days take about 75 s. Use `stream` from the response for the WebSocket. |
| `GET /realtime/replay/:id` | `ReplayInfo` plus `clusterer` stats |
| `POST /realtime/replay/:id/pause` · `/resume` · `/stop` | Replay control. Returns `ReplayInfo`. A replay paused for more than 30 min (since it started) gives up its slot to the next start. |
| `GET /realtime/ws?stream=` | WebSocket (§2) |

Starting a replay (`POST /realtime/replay`) is **public**: it reuses the running replay, only one replay runs at a time, and replay briefs come from the brief cache after the first run, so it costs nothing to repeat. When the `REPLAY_TOKEN` secret is set (production), `pause`, `resume` and `stop` need the header `x-replay-token: <token>`, otherwise 401 `unauthorized`. `GET` routes and the WebSocket stay open. Locally the secret is unset and no header is needed.

`ReplayInfo`:

```ts
{ id, stream: "replay:<id>", scenario, origin: "r2" | "kv" | "bundled", note: string | null, speed, reused,
  status: "running" | "paused" | "stopped" | "done" | "error",
  startT, endT, streamT, total, emitted, progress, createdAt, finishedAt, expectedDurationS, error }
```

Scenarios:
- `quebec-2023-06`: 59,968 VIIRS SP detections, bbox -80,45,-60,53. Stored in R2 as `scenarios/quebec-2023-06.json` when the `REPLAY_DATA` bucket is bound, otherwise in KV `REPLAY_KV` as `scenarios/quebec-2023-06.json.gz` (gzipped: 2.7 MB → 0.53 MB, about 2% of KV's 25 MiB value limit; decompressed with `DecompressionStream`). R2 is read first when bound.
- `california-2020-08-sample`: bundled in the worker (4,880 rows from `sample_api/`, LNU Complex area). It is also used automatically when a requested scenario is in neither store; `origin: "bundled"` and `note` say so.

Starting a replay from the UI:

```ts
const r = await fetch(`${REALTIME_BASE}/realtime/replay`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ scenario: "quebec-2023-06" })
}).then((r) => r.json());
const stop = connectRealtime(r.stream, map, handlers);   // r.stream = "replay:<id>"
map.fitBounds([[-80, 45], [-60, 53]]);
// Also send it to the chat copilot as context.realtimeStream = r.stream
```

### Enrichment (`GET /realtime/incidents/:id` → `enrichment`)

The `INCIDENT_ENRICH` Workflow (weather, places, history, AI brief) runs for an incident once, and again when its affected area has doubled (at most once per 6 h of stream time). Due incidents go into a per-stream queue, and each ingest batch starts at most 2 of them, **largest affected area first** (first briefs before re-briefs), so a busy stream briefs its biggest fires first rather than the first ones to cross a threshold.

When an incident is due for its first brief:
- `live`: as soon as it is significant.
- replays: once it is significant **and** `affectedAreaKm2 ≥ BRIEF_MIN_AREA_KM2` (default 200). In the Quebec scenario, 21 incidents end at or above 200 km² (30 cross it at some point; 9 of those later merge into a neighbour and are dropped from the queue). The largest (about 4,500 km²) gets its brief during a default-speed replay.

Budgets (every run makes one AI call; re-briefs count):
- `ENRICH_MAX_PER_STREAM` (30): per replay stream, and per rolling 24 h (wall clock) for `live`.
- `BRIEF_DAILY_MAX` (400, about 14,000 neurons): across **all** streams per rolling 24 h, tracked in the `Control` Durable Object.

**Replay brief cache.** Replays are deterministic, so a brief written during one replay is reused by later replays of the same scenario. The key in `REPLAY_KV` is `brief-cache/v1/<scenario>/<first detection id of the incident>/<level>` (level 0 = first brief, n = n-th area doubling). A hit skips the model call and does **not** count against `BRIEF_DAILY_MAX` (it still counts toward the per-stream cap, because the Workflow still fetches weather and places). Cached briefs carry `cached: true` and keep the `asOf` of the replay that wrote them; because tick timing varies a little between runs, their numbers can differ slightly from the incident's state at that moment. Bump `BRIEF_CACHE_VERSION` in `src/enrich/brief.ts` when the prompt changes. Clusterer counters `brief_cache_hits` / `brief_cache_misses` (in `GET /realtime/replay/:id`) give the hit rate.

What does not fit stays queued and is retried on later batches. `GET /realtime/replay/:id` → `clusterer.enrich` and `/realtime/health` → `briefBudget` show the usage.

A failed step is recorded and does not fail the run.

```ts
{
  incidentId, reason: "significant" | "area_doubled", streamT, completedAt,
  weather: { status: "ok", data: { source: "open-meteo-forecast" | "open-meteo-archive", time, windSpeedKmh,
             windDirectionDeg, windFrom: "NW", relativeHumidityPct, temperatureC } } | { status: "failed", error },
  places:  { status: "ok", data: [{ name, place: "city" | "town" | "village" | "hamlet" | "locality", distanceKm, direction, population }],
             source: "overpass" | "photon", radiusKm: 75 }
           | { status: "failed", error, unavailable: true },
  history: { status: "ok", data: { dataSource: "mock" | "live", summary } } | { status: "skipped", reason } | { status: "failed", error },
  brief:   { status: "ok", data: { text, model, generatedAt, streamT } } | { status: "failed", error }
}
```

- Replays get the weather **at stream time** from the Open-Meteo historical archive.
- Places: populated places (city, town, village, hamlet, locality) within **75 km**, nearest first (up to 8; a city/town outranks a smaller place within 5 km). Overpass is tried first (two endpoints, 8 s each), then Photon reverse geocoding (photon.komoot.io). In the UI, `status: "ok"` with an empty list means **none within 75 km**; `status: "failed"` means the lookup is **unavailable** (show "unavailable", not "none"; `error` gives every source's reason). History: until 2026-11-15 the step searched only cities/towns within 30 km on Overpass with a 15 s step timeout, and on the deployed worker it failed for every Quebec incident (`WorkflowTimeoutError: Execution timed out after 15000ms`). Overpass still fails from Workers today, so Photon supplies the places.
- Historical context: `POST /api/calendar` on api-worker (service binding `API`, same account) with `{ bbox, from, to }`: the incident bbox padded to at least 0.5° a side, the 15 years before the stream year. The step turns the response (`climatology`, `annual`, `summary`) into one line, e.g. "2005-2019 harmonized archive; typical Aug 4 active cell-days (p90 12.2, 15 years); fire season Feb/Oct/Nov; busiest year 2017", which the brief cites. `skipped` with reason **"outside harmonized coverage (US regions only)"** (plus `coverage`, 0..1) when api-worker answers 422 `outside_regions` (under half of the area's 0.05° cells are in a harmonized region on US territory, so every Quebec incident) or when the calendar is all zeros; `skipped` with the error code when api-worker is unreachable or answers 404/413/503.
- The brief is 2 or 3 plain sentences written only from these numbers, with no advice. The prompt calls the size "area with detections" and forbids "burned area" (the output is also scrubbed for it). `brief.asOf` (ISO) / `brief.streamT` say which moment it describes, so show "as of <time>" next to it, because the incident may have grown since.

#### Brief model settings

Measured on 2026-11-15 against `@cf/moonshotai/kimi-k2.6` with a Quebec-sized prompt (Workers AI REST, no gateway cache):

| `reasoning_effort` | `max_tokens` | Latency per brief | Completion tokens | Neurons | Result |
|---|---|---|---|---|---|
| default (high) | 4096 | 29–55 s | 1,250–2,250 | 460–840 | OK (before) |
| `low` | 4096 | 54–63 s | 2,240–2,800 | 820–1,030 | OK; `low` is mapped to `high` for this model |
| `low` | 1024 | 23 s | 1,024 | 380 | **empty** (all tokens spent reasoning) |
| `none` | 4096 | 2.1–2.2 s | 75–77 | 35 | OK |
| `none` | 160 | 2.0–2.5 s | 73–75 | 34 | OK |
| `none` | 100 | 2.5 s | 74–76 | 35 | OK |
| `none` | 80 | 2.2–2.7 s | 71–74 | 34 | OK, but only a few tokens to spare |
| `none` | 64 | 2.5–2.8 s | 64 | 30 | cut off mid-sentence |

So the defaults are `BRIEF_REASONING_EFFORT=none` and `BRIEF_MAX_TOKENS=120`: about 20× faster and 20× fewer neurons than before. With reasoning off, a lower `max_tokens` saves nothing until it truncates the brief, so 120 keeps headroom over the ~75 tokens a brief uses. If a reply is cut off anyway, the trailing half-sentence is dropped. The reasoning setting is only sent to kimi models; the fallback model gets its own defaults.

---

## 4. Chat copilot

The api-worker copilot has a `get_live_incidents` tool that calls this worker through the `REALTIME` service binding. Send the stream the map shows as part of the chat context:

```ts
body: () => ({ context: { ...currentMapContext(), realtimeStream: "live" /* or "replay:<id>" */ } })
```

If the context has no stream, the tool uses `live` and the map's AOI bbox. Results carry `dataSource: "live" | "replay"`, and the model is told to call a replay a replay.

---

## 5. Configuration

| Name | Kind | Default | Notes |
|---|---|---|---|
| `ALLOWED_ORIGINS` | var | see notes | Comma-separated exact origins, plus `https://*.<suffix>` entries that match exactly one subdomain label over https (Pages preview URLs; see `src/origins.ts`). No other wildcards. Deployed: `http://localhost:5173,https://skywalkers77-fire.pages.dev,https://*.skywalkers77-fire.pages.dev,https://nasa-fire-web.pages.dev` (the last one is the old account's fallback site; drop it after submission). CORS and WebSocket origin check. |
| `REPLAY_DEFAULT_SPEED` | var | `12000` | Stream seconds per real second |
| `WATCH_BBOXES` | var | `-170,15,-50,72` | `;`-separated `w,s,e,n` boxes polled live |
| `AI_GATEWAY_ID` | var | `default` | Same as api-worker |
| `CHAT_MODEL` / `CHAT_FALLBACK_MODEL` | var | `@cf/moonshotai/kimi-k2.6` / `@cf/zai-org/glm-4.7-flash` | Brief models, same pattern as api-worker. `CHAT_FALLBACK_MODEL=""` disables the fallback. |
| `ENRICH_MAX_PER_STREAM` | var | `30` | Workflow runs (and AI calls) per replay stream, and per rolling 24 h for `live` |
| `BRIEF_DAILY_MAX` | var | `400` | AI briefs per rolling 24 h across all streams (re-briefs count; cached replay briefs do not) |
| `BRIEF_MIN_AREA_KM2` | var | `200` | Replays only brief incidents with at least this `affectedAreaKm2` |
| `BRIEF_REASONING_EFFORT` | var | `none` | Sent to kimi models only. `""` = model default. kimi-k2.6 accepts `high` or `none` (`low`/`medium` map to `high`). |
| `BRIEF_MAX_TOKENS` | var | `120` | Brief output budget |
| `REPLAY_TOKEN` | secret | unset | When set, replay pause/resume/stop need `x-replay-token` (start is public). `wrangler secret put REPLAY_TOKEN` in production; leave unset locally. |
| `FIRMS_MAP_KEY` | secret | — | `.dev.vars` locally; `wrangler secret put FIRMS_MAP_KEY` in production |

Bindings: Durable Objects `CLUSTERER`, `INCIDENT`, `LIVE_HUB`, `REPLAY` and `CONTROL` (all SQLite-backed; `CONTROL` is one global instance holding the replay slot and the brief budget); KV `INGEST_STATE` and `REPLAY_KV` (replay scenarios when R2 is not bound, and the replay brief cache); R2 `REPLAY_DATA` (bucket `nasa-fire-realtime`; **optional**: comment out `r2_buckets` on an account without R2 and scenarios come from `REPLAY_KV` while the raw NRT CSV archive is skipped with a `realtime_poll_archive_skipped` log line); Queue `DETECTIONS_QUEUE` (`nasa-fire-detections`, producer and consumer); Workflow `INCIDENT_ENRICH` (`nasa-fire-incident-enrich`); `AI`; service `API` (api-worker, optional).

---

## 6. Running locally

```sh
cd apps/realtime-worker
cp .dev.vars.example .dev.vars          # set FIRMS_MAP_KEY
pnpm dev                                # :8789, --test-scheduled, shared state in ../../.wrangler/shared-state
pnpm fetch-replay-fixture               # once: Quebec archive → data/quebec-2023-06.json(.gz) → KV, or R2 if bound (local + remote)
pnpm fetch-replay-fixture --upload-only # re-upload the existing data file without calling FIRMS
pnpm replay-smoke                       # replay + WebSocket checks (SCENARIO, SPEED, HOST, WAIT_BRIEFS_S=120)
curl "http://localhost:8789/__scheduled?cron=*/10+*+*+*+*"   # one live poll (or /cdn-cgi/local/scheduled)
pnpm test && pnpm typecheck
pnpm typegen                            # after editing wrangler.jsonc
```

- If Quebec is not in local KV/R2 (you skipped `fetch-replay-fixture`), replays play the bundled California sample.
- `AI` runs remotely even in dev, so briefs use your account's Workers AI quota (about 35 neurons per brief with the defaults, capped by `ENRICH_MAX_PER_STREAM` and `BRIEF_DAILY_MAX`).
- To use the history step, run api-worker (`pnpm dev:api`) at the same time. The service binding connects through the local dev registry.

---

## 7. Deployment

Everything runs on the team account `7d56e968…` (Hemanth's; Workers Paid), AI Gateway `default`, since 2026-11-15:

| Worker / site | URL |
|---|---|
| realtime-worker (`nasa-fire-realtime`) | https://nasa-fire-realtime.hemanth3292.workers.dev |
| api-worker (`nasa-fire-api`, copilot + archival API) | https://nasa-fire-api.hemanth3292.workers.dev |
| web (Pages `skywalkers77-fire`) | https://skywalkers77-fire.pages.dev |

Resources on that account: Queue `nasa-fire-detections`, KV `FIRMS_INGEST_STATE` (binding `INGEST_STATE`, shared with ingest-worker and api-worker; realtime keys are `realtime:poll:*`) and `REPLAY_KV`, R2 `nasa-fire-realtime` (Quebec scenario in both R2 and KV; R2 is read first), D1 `firms-nrt-cells` and Hyperdrive `firms-pg` (api-worker / ingest-worker). Secrets: `FIRMS_MAP_KEY` and `REPLAY_TOKEN` (realtime), `TAVILY_API_KEY` (api).

The old deployment on account `6584e46c…` (`*.kj2743.workers.dev`, Pages `nasa-fire-web`) is a fallback until after submission; its realtime cron is removed so FIRMS is polled once.

`account_id` in `wrangler.jsonc` overrides `CLOUDFLARE_ACCOUNT_ID`, so it decides where resources and deploys go.

**First deploy on a new account:** the two workers bind each other (`API` ↔ `REALTIME`), and a service binding to a Worker that does not exist yet fails with code 10143. Deploy realtime-worker once without its `services` block (a temporary copy of `wrangler.jsonc`; the enrich Workflow skips the history step without `API`), then api-worker, then realtime-worker again with the normal config. Later deploys need nothing special.

```sh
pnpm fetch-replay-fixture --upload-only --store=r2   # and --store=kv
npx wrangler deploy --dry-run && npx wrangler deploy
HOST=nasa-fire-realtime.hemanth3292.workers.dev REPLAY_TOKEN=... WAIT_BRIEFS_S=180 pnpm replay-smoke
```
