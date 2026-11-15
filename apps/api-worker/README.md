# `api-worker` — Unified Harmonization API & Emergency Copilot

User-facing Cloudflare Worker built with Hono.

## Endpoints
- **`POST /api/calendar`**
  - Accepts a GeoJSON polygon or bounding box (`bbox`) + optional year range.
  - Queries historical `_SP` cells from **PlanetScale Postgres** (via `env.HYPERDRIVE`) and live `_NRT` cells from **D1** (`env.NRT_DB`) concurrently via `Promise.all()`.
  - Deduplicates any overlapping dates (preferring `_SP` over `_NRT`).
  - Runs `@repo/harmonizer` to compute local monthly calibration factors ($\alpha_m$) across the 2012–2025 sensor overlap window and returns the `Year × Month` matrix, anomaly Z-scores, and GeoJSON grid summary.
- **Chat copilot: `/agents/fire-copilot-agent/<sessionId>`** (WebSocket + HTTP via the Agents SDK)
  - `FireCopilotAgent` (`AIChatAgent`) calls the model through **Cloudflare AI Gateway** (`env.AI`). Transcript, long-term memories and the last map context live in the session's Durable Object SQLite.
  - Answers are grounded in the user's active AOI via data tools (calendar, spots, month-to-date). Web news comes from `web_search` / `web_fetch`. Data is **mocked** until LiveFireData lands.
  - See [`CHAT.md`](CHAT.md) for setup, configuration and the frontend contract.

## Implementation Rules
- Always instantiate a fresh Postgres client per request using `env.HYPERDRIVE.connectionString` (never in global scope).
- Cache `/api/calendar` responses in the Cloudflare Cache API keyed by rounded polygon hash + latest D1 ingest timestamp.
