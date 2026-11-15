# Chat copilot (`FireCopilotAgent`)

A wildfire-activity analyst for emergency managers. It runs as a Cloudflare Agents SDK chat agent (`AIChatAgent` from `@cloudflare/ai-chat`) inside `api-worker`. Each chat session is one Durable Object with its own SQLite. The model is called through AI Gateway, and answers are grounded in data tools for the AOI the user is viewing.

## Layout

```
src/index.ts              Hono app: CORS, GET /api/health, /agents/* → routeAgentRequest
src/copilot/agent.ts      FireCopilotAgent (turn loop, state, model, tools)
src/copilot/context.ts    zod schema for body.context sent by the web app
src/copilot/memory.ts     memories table (aoi | preference | finding), dedupe, cap 50, keyword search
src/copilot/tools.ts      get_calendar, get_spots_summary, get_month_to_date, remember, recall
src/copilot/web.ts        web_fetch (always) + web_search (Tavily or Cloudflare)
src/copilot/prompt.ts     system prompt (rebuilt every turn)
src/data/fireData.ts      FireData interface + createFireData(env)  ← LiveFireData TODO here
src/data/mockFireData.ts  demo data source (see "What is mocked")
src/data/sample-fixture.json  built from sample_api/ by scripts/build-fixtures.mjs
scripts/chat-smoke.mjs    end-to-end WebSocket smoke test
```

## Setup (once)

1. `pnpm install` at the repo root.
2. `npx wrangler login`. The `AI` binding has no local implementation, so even under `wrangler dev` it runs against (and bills) the account you are logged in to.
3. **Create the AI Gateway** named `nasa-fire-copilot` in the Cloudflare dashboard (AI → AI Gateway → Create gateway), in the same account. Without it every chat turn fails with `code 2001: Please configure AI Gateway`. Recommended gateway settings: rate limit 30 req/min, caching on.
4. Secrets: `cp .dev.vars.example .dev.vars` and set `TAVILY_API_KEY`. For production, run `npx wrangler secret put TAVILY_API_KEY`.

## Run locally

```sh
cd apps/api-worker
# Hyperdrive has a placeholder id; the copilot does not use it, but wrangler needs a local string.
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://dev:dev@localhost:5432/dev"
pnpm dev                 # http://localhost:8787
pnpm smoke               # in another terminal: two-turn chat over WebSocket
pnpm test                # vitest: mock data, Tavily mapping, memory store, context parsing
pnpm typecheck
pnpm fixtures            # rebuild src/data/sample-fixture.json from sample_api/
pnpm typegen             # after editing wrangler.jsonc (wrangler types --strict-vars=false)
```

`pnpm smoke` respects `HOST` (default `localhost:8787`) and `SESSION`.

## Configuration

| Name | Kind | Default | Notes |
|---|---|---|---|
| `AI_GATEWAY_ID` | var | `nasa-fire-copilot` | The gateway must exist in the account. |
| `CHAT_MODEL` | var | `@cf/moonshotai/kimi-k2.6` | A Workers AI id (`@cf/…`), an AI Gateway catalog id (`anthropic/claude-opus-4.8`, `openai/gpt-5.5`), or `dynamic/<route>`. Fallback model: `@cf/zai-org/glm-4.7-flash`. |
| `WEB_SEARCH_PROVIDER` | var | `tavily` | `tavily` or `cloudflare`. |
| `TAVILY_API_KEY` | secret | — | Needed for `tavily`. If it is missing, `web_search` is disabled with a warning; `web_fetch` still works. |
| `FIRE_DATA_SOURCE` | var | `mock` | Only `mock` exists today (see below). |
| `ALLOWED_ORIGINS` | var | `http://localhost:5173` | Comma-separated. Also enforced on the agent WebSocket (other origins get 403). |

**Switch the model:** set `CHAT_MODEL` in `wrangler.jsonc` (or `wrangler dev --var CHAT_MODEL:anthropic/claude-opus-4.8`). Catalog models bill via Unified Billing or a key stored on the gateway; no code change is needed.

**Switch search:** set `WEB_SEARCH_PROVIDER` to `cloudflare` to use the Cloudflare Web Search API through `env.AI` and the gateway. It needs AI Gateway credits or a provider key on the gateway. `tavily` calls `https://api.tavily.com/search` directly with the secret key.

## Agent behaviour

- **Routing:** `/agents/fire-copilot-agent/<sessionId>` (WebSocket and HTTP) via `routeAgentRequest`. The Durable Object binding is named `FireCopilotAgent`, the same as the class, because `routeAgentRequest` resolves bindings by class name.
- **Per turn:** parse `body.context` (invalid context is logged and ignored). If it is valid, store it with `setState({ context, contextUpdatedAt })`. Then build the tools and the system prompt (date, map context, memories, rules) and send the **last 30 messages** to the model, with up to 6 tool steps. The abort signal is forwarded, so "stop" cancels the LLM call.
- **Memory:** the transcript is persisted by `AIChatAgent`, capped at 200 messages. Long-term facts are kept in the `memories` table, which is injected into every prompt and written by the `remember` tool. The latest map context is kept in agent state.
- **Tools:** all arguments are optional and fall back to the stored context. With no bbox, a tool returns `{ "error": "no_area" }`, and the model asks the user to select an area.

| Tool | Args | Returns |
|---|---|---|
| `get_calendar` | `bbox?, from?, to?, months?` | summary (peak month/year, critical months, totals), climatology, annual, top 8 notable months |
| `get_spots_summary` | `mode?, bbox?, from?, to?` | detection counts, cell-days per satellite, daily activity, last seen, top detections by FRP |
| `get_month_to_date` | `bbox?` | this month so far vs historical median |
| `remember` | `kind, content` | saved memory |
| `recall` | `query` | matching memories |
| `web_search` | `query, limit?` | news/agency results (never used for counts) |
| `web_fetch` | `url, offset?, format?` | page as Markdown, wrapped as untrusted content |

## What is mocked

`createFireData(env)` always returns `MockFireData` for now:

- `get_spots_summary` uses **real** FIRMS detections from `sample_api/` (California 2020-08-15 → 08-19, MODIS + VIIRS S-NPP, plus 8 MODIS NRT rows from 2026-11-13). These are filtered and aggregated to 0.05° cell-days per satellite by `scripts/build-fixtures.mjs`.
- `get_calendar` and `get_month_to_date` return **synthetic**, deterministic, California-shaped numbers: peaks in Jul–Sep, and standout months such as Aug/Sep 2020, Nov 2018, Dec 2017 and Jan 2025.
- Every result carries `dataSource: "mock"` and a `note`. The system prompt makes the model tell the user that the numbers are demo data.

To go live, implement `LiveFireData` (see the TODO in `src/data/fireData.ts`), using the same internal functions as `POST /api/calendar` and `/api/*/spots`, and return it when `FIRE_DATA_SOURCE=live`.

## Frontend contract

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

const sessionId =
  localStorage.getItem("copilotSessionId") ??
  (() => {
    const id = crypto.randomUUID();
    localStorage.setItem("copilotSessionId", id);
    return id;
  })();

const agent = useAgent({
  agent: "FireCopilotAgent",
  name: sessionId,
  host: new URL(import.meta.env.VITE_API_BASE).host // e.g. "localhost:8787"
});

const { messages, sendMessage, status, stop, clearHistory } = useAgentChat({
  agent,
  // Sent with EVERY message; a function so it always reads the latest map state.
  body: () => ({ context: currentMapContext() })
});
```

`context` shape (validated by `src/copilot/context.ts`):

```ts
{
  tab: "archival" | "realtime",
  aoi: { bbox: [w, s, e, n], label?: string, geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon } | null,
  from: "YYYY-MM-DD",
  to: "YYYY-MM-DD",
  calendarSummary?: unknown   // what the calendar drawer shows; truncated to 1.5 KB in the prompt
}
```

Render `text` parts as Markdown, because web facts are cited as Markdown links. Tool parts (`tool-get_calendar`, `tool-web_search`, …) can be shown as small "looked up…" chips. `agent.state.context` mirrors the context the agent last stored.
