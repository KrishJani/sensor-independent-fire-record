# `api-worker`: archival API and fire copilot

A Cloudflare Worker built with Hono. Full spec: [`SPEC.md`](SPEC.md). Copilot details: [`CHAT.md`](CHAT.md).

## Endpoints
- **`POST /api/calendar`** (archival only): a Year × Month calendar for a `scope` (`us` or a region id,
  precomputed), a `bbox` or a GeoJSON `geometry`. Areas are rebuilt from Postgres `cell_days` (through
  `env.HYPERDRIVE`) with each region's own daily rule and α; anomalies come from `@repo/harmonizer`.
  Areas mostly outside the harmonized US regions get `422 outside_regions`.
- **`GET /api/export/calendar.csv`**: the same calendar as CSV.
- **`GET /api/archival/spots`**: map layers (0.5° bins, 0.05° cells or detections) for a bbox and date range.
- **`GET /api/realtime/spots`**: the same from D1 (last 92 days of NRT data).
- **`GET /api/prone`**, **`GET /api/prone/summary`**: fire-prone tiles.
- **`GET /api/meta`**, **`GET /api/health`**: loaded archive bounds and data versions; connectivity.
  `archival.detail` is `false` after a summary-only load (`backfill load --summary-only`); the spots
  endpoint and calendars for a bbox or geometry then answer `404 detail_not_loaded`.
- **Chat copilot: `/agents/fire-copilot-agent/<sessionId>`** (WebSocket and HTTP through the Agents SDK).
  `FireCopilotAgent` (`AIChatAgent`) calls the model through Cloudflare AI Gateway (`env.AI`). The
  transcript, long-term memories and the last map context live in the session's Durable Object SQLite.
  The calendar, hot spot and month-to-date tools return demo data (`FIRE_DATA_SOURCE=mock`) and answers
  say so; `get_live_incidents` reads realtime-worker over the `REALTIME` service binding.

## Implementation notes
- A new Postgres client per request from `env.HYPERDRIVE.connectionString`, closed after the response.
- Archival and realtime responses are cached with the Cache API, keyed by the normalized request and the
  KV data version (`data:version:archival` or `data:version:realtime`), so a new load invalidates them.
