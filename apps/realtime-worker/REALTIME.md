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
- `areaKm2` is the summed area of active grid cells (each cell shrinks with cos(lat)). It is **not** a burned-area perimeter. Say "area of active cells" in the UI.

### `IncidentSummary`

```ts
{
  id: string;                 // "live.42" or "replay-ab12cd34ef.7"
  stream: string;             // "live" | "replay:<id>"
  status: "active" | "inactive" | "merged";
  significant: boolean;
  mergedInto: string | null;
  detections: number;         // non-low-confidence detections
  cells: number;              // active 0.05° cells
  areaKm2: number;
  frpTotalMw: number;
  frpMaxMw: number;
  frpMaxSensor: "VIIRS" | "MODIS" | null;   // FRP is not harmonized: always show the sensor
  firstSeen: number;          // epoch ms (UTC detection time)
  lastSeen: number;
  centroid: [lon, lat];
  bbox: [w, s, e, n];
  growthKm2PerDay: number;    // area of cells first seen in the last 24 h of stream time
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
| `incident.brief` | `{ id, brief: { text, model, generatedAt, streamT } }` | An AI brief is ready, or was refreshed after the area doubled |
| `detections` | `{ points: [lon, lat, frpMw, tMs, conf][], replace?: true }` | New detections inside your viewport. `conf` is 0 (low), 1 (nominal) or 2 (high). With `replace: true`, the points replace your heat layer (on connect and after a viewport change); otherwise append them. |
| `clock` | `{ t: number }` | Replay only: stream time advanced (each tick, about 2/s) |
| `replay.status` | `{ status: "running" \| "paused" \| "stopped" \| "done", progress: 0..1 }` | Replay only |
| `error` | `{ message }` | A bad client message |

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
- **Incidents:** keep a `Map<id, IncidentSummary>`. Draw `centroid` as a circle sized by `areaKm2`, or draw `bbox` as an outline. Hide `status: "merged"` and dim `inactive`.
- **Clock (replay):** show `new Date(t).toISOString()` as "Replay time". For live, use `max(lastSeen)`, or `streamT` from `/realtime/incidents`.

---

## 3. REST

All responses are JSON. Errors are `{ error: { code, message } }` with status 400, 404 or 500. CORS is limited to `ALLOWED_ORIGINS`.

| Method and path | Purpose |
|---|---|
| `GET /realtime/health` | `{ ok, live: { streamT, counters, incidents, merges }, poll: { "<SOURCE>:<bbox>": PollState }, scenarios }` |
| `GET /realtime/incidents?stream=live&bbox=w,s,e,n&status=active\|inactive\|merged\|all&limit=200` | `{ stream, streamT, dataSource: "live"\|"replay", count, incidents: IncidentSummary[] }`, sorted by area (largest first). Only significant incidents (`&minor=1` includes all). `bbox` intersects the incident bbox. Default status is `all`. |
| `GET /realtime/incidents/:id` | `{ summary, timeline, enrichments, enrichment, brief, stream, streamT, dataSource }`. `timeline` is hourly: `[{ hour, detections, newCells, frp, areaKm2 }]` (cumulative area). `enrichment` is described below. |
| `POST /realtime/replay` body `{ scenario?: "quebec-2023-06", speed?: number }` | Starts a replay and returns `ReplayInfo` (201). `speed` is stream seconds per real second; the default `REPLAY_DEFAULT_SPEED` is 12000, so 10 days take about 75 s. Use `stream` from the response for the WebSocket. |
| `GET /realtime/replay/:id` | `ReplayInfo` plus `clusterer` stats |
| `POST /realtime/replay/:id/pause` · `/resume` · `/stop` | Replay control. Returns `ReplayInfo`. |
| `GET /realtime/ws?stream=` | WebSocket (§2) |

`ReplayInfo`:

```ts
{ id, stream: "replay:<id>", scenario, origin: "r2" | "bundled", note: string | null, speed,
  status: "running" | "paused" | "stopped" | "done" | "error",
  startT, endT, streamT, total, emitted, progress, createdAt, finishedAt, expectedDurationS, error }
```

Scenarios:
- `quebec-2023-06`: R2 `scenarios/quebec-2023-06.json`, 59,968 VIIRS SP detections, bbox -80,45,-60,53.
- `california-2020-08-sample`: bundled in the worker (4,880 rows from `sample_api/`, LNU Complex area). It is also used automatically when a requested scenario is missing from R2; `origin: "bundled"` and `note` say so.

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

The `INCIDENT_ENRICH` Workflow runs when an incident first becomes significant, and again when its area has doubled (at most once per 6 h of stream time). There are at most `ENRICH_MAX_PER_STREAM` runs per stream. A failed step is recorded and does not fail the run.

```ts
{
  incidentId, reason: "significant" | "area_doubled", streamT, completedAt,
  weather: { status: "ok", data: { source: "open-meteo-forecast" | "open-meteo-archive", time, windSpeedKmh,
             windDirectionDeg, windFrom: "NW", relativeHumidityPct, temperatureC } } | { status: "failed", error },
  places:  { status: "ok", data: [{ name, place: "town" | "city", distanceKm, direction, population }] } | { status: "failed", error },
  history: { status: "ok", data: { dataSource: "mock" | "live", summary } } | { status: "skipped", reason } | { status: "failed", error },
  brief:   { status: "ok", data: { text, model, generatedAt, streamT } } | { status: "failed", error }
}
```

- Replays get the weather **at stream time** from the Open-Meteo historical archive.
- The brief is 2 or 3 plain sentences written only from these numbers, with no advice. `brief.streamT` says which moment it describes, so show "as of <time>" next to it, because the incident may have grown since.

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
| `ALLOWED_ORIGINS` | var | `http://localhost:5173` | Comma-separated. CORS and WebSocket origin check. |
| `REPLAY_DEFAULT_SPEED` | var | `12000` | Stream seconds per real second |
| `WATCH_BBOXES` | var | `-170,15,-50,72` | `;`-separated `w,s,e,n` boxes polled live |
| `AI_GATEWAY_ID` | var | `default` | Same as api-worker |
| `CHAT_MODEL` / `CHAT_FALLBACK_MODEL` | var | `@cf/moonshotai/kimi-k2.6` / `@cf/zai-org/glm-4.7-flash` | Brief models, same pattern as api-worker |
| `ENRICH_MAX_PER_STREAM` | var | `30` | Caps Workflow runs (and AI calls) per stream |
| `FIRMS_MAP_KEY` | secret | — | `.dev.vars` locally; `wrangler secret put FIRMS_MAP_KEY` in production |

Bindings: Durable Objects `CLUSTERER`, `INCIDENT`, `LIVE_HUB` and `REPLAY` (all SQLite-backed); R2 `REPLAY_DATA` (bucket `nasa-fire-realtime`); KV `INGEST_STATE`; Queue `DETECTIONS_QUEUE` (`nasa-fire-detections`, producer and consumer); Workflow `INCIDENT_ENRICH` (`nasa-fire-incident-enrich`); `AI`; service `API` (api-worker, optional).

---

## 6. Running locally

```sh
cd apps/realtime-worker
cp .dev.vars.example .dev.vars          # set FIRMS_MAP_KEY
pnpm dev                                # :8789, --test-scheduled, shared state in ../../.wrangler/shared-state
pnpm fetch-replay-fixture               # once: Quebec archive → data/quebec-2023-06.json → R2 (local + remote)
pnpm replay-smoke                       # replay + WebSocket checks (SCENARIO, SPEED, HOST, WAIT_BRIEFS_S=120)
curl "http://localhost:8789/__scheduled?cron=*/10+*+*+*+*"   # one live poll (or /cdn-cgi/local/scheduled)
pnpm test && pnpm typecheck
pnpm typegen                            # after editing wrangler.jsonc
```

- If Quebec is not in local R2 (you skipped `fetch-replay-fixture`), replays play the bundled California sample.
- `AI` runs remotely even in dev, so briefs use your account's Workers AI quota (about 1 call per significant incident, capped by `ENRICH_MAX_PER_STREAM`).
- To use the history step, run api-worker (`pnpm dev:api`) at the same time. The service binding connects through the local dev registry.
