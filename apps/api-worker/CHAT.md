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
src/copilot/realtime.ts   get_live_incidents (realtime-worker via the REALTIME service binding)
src/copilot/prompt.ts     system prompt (rebuilt every turn)
src/copilot/disclaimer.ts demo-data notice inserted into the stream
src/copilot/postprocess.ts final pass: text-part spacing, link verification, "your area" → "this area"
src/data/fireData.ts      FireData interface + createFireData(env)  ← LiveFireData TODO here
src/data/mockFireData.ts  demo data source (see "What is mocked")
src/data/sample-fixture.json  built from sample_api/ by scripts/build-fixtures.mjs
scripts/chat-smoke.mjs    end-to-end WebSocket smoke test with answer-quality checks
scripts/compare-models.mjs  runs the smoke test against several CHAT_MODELs and prints a scorecard
```

## Setup (once)

> **Temporary:** `wrangler.jsonc` currently points at Hemanth's account (`account_id` `7d56e968…`) and uses that account's `default` AI Gateway (`AI_GATEWAY_ID: "default"`). Switch both back to the team account and the `nasa-fire-copilot` gateway once it exists there.

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
pnpm smoke               # in another terminal: two-turn chat over WebSocket + quality checks
pnpm compare-models      # starts its own wrangler dev per model on :8790 (no pnpm dev needed)
pnpm test                # vitest: mock data, Tavily mapping, memory store, context parsing
pnpm typecheck
pnpm fixtures            # rebuild src/data/sample-fixture.json from sample_api/
pnpm typegen             # after editing wrangler.jsonc (wrangler types --strict-vars=false)
```

`pnpm smoke` respects `HOST` (default `localhost:8787`), `SESSION`, `SMOKE_JSON=1` (one-line JSON result) and `SMOKE_DEBUG=1` (log every stream chunk type). It exits 1 when a check fails:

| Turn | Check (every one is a FAIL) |
|---|---|
| both | CJK characters (language drift); two text parts glued without a space ("stillin"); "your area"; echoed instructions ("You never…", "You do not…"); banned filler ("workload", "intense activity"); a source named in brackets without a link (`[Wikipedia; CAL FIRE]`, `[link]`); a link to a URL that no `web_search`/`web_fetch` call returned in the conversation |
| 1 ("What happened in this area in August 2020?") | `get_spots_summary` not called; mock data used but the first sentence does not mention demo/synthetic data; no web tool called but the reply has links or a "Sources" section |
| 2 ("…what does the news say about the August Complex fire?") | neither `web_search` nor `web_fetch` called; a page read with `web_fetch` is not linked in the reply |

`pnpm compare-models` takes `MODELS` (comma-separated), `RUNS` (default 2), `PORT` (default 8790) and `OUT` (full replies as JSON, default `compare-models.json`).

## Configuration

| Name | Kind | Default | Notes |
|---|---|---|---|
| `AI_GATEWAY_ID` | var | `nasa-fire-copilot` | The gateway must exist in the account. |
| `CHAT_MODEL` | var | `@cf/moonshotai/kimi-k2.6` | A Workers AI id (`@cf/…`), an AI Gateway catalog id (`anthropic/claude-opus-4.8`, `openai/gpt-5.5`), or `dynamic/<route>`. |
| `CHAT_FALLBACK_MODEL` | var | `@cf/zai-org/glm-4.7-flash` | Tried when `CHAT_MODEL` fails before producing output. Set to `""` to disable the fallback (the demo setting, below). |
| `WEB_SEARCH_PROVIDER` | var | `tavily` | `tavily` or `cloudflare`. |
| `TAVILY_API_KEY` | secret | — | Needed for `tavily`. If it is missing, `web_search` is disabled with a warning; `web_fetch` still works. |
| `FIRE_DATA_SOURCE` | var | `mock` | Only `mock` exists today (see below). |
| `ALLOWED_ORIGINS` | var | `http://localhost:5173` | Comma-separated. Also enforced on the agent WebSocket (other origins get 403). |

**Demo setting: `CHAT_FALLBACK_MODEL=""`.** With the fallback disabled, a failing `CHAT_MODEL` call shows the user an error ("could not answer right now, please try again") instead of an answer from `glm-4.7-flash`, the only model that drifted into Chinese after the language rule was added (see the comparison below). For a public demo, an error on retry is better than a Chinese answer. Set it in `wrangler.jsonc` (`"CHAT_FALLBACK_MODEL": ""`) or with `wrangler dev --var CHAT_FALLBACK_MODEL:`. Leaving the variable out keeps the default fallback. Each turn logs `copilot_turn_done` with the model that answered, so a drifted reply can be traced to a model in the worker logs (`wrangler tail`) or in AI Gateway.

**Switch the model:** set `CHAT_MODEL` in `wrangler.jsonc` (or `wrangler dev --var CHAT_MODEL:anthropic/claude-opus-4.8`). Catalog models bill via Unified Billing or a key stored on the gateway; no code change is needed.

**Switch search:** set `WEB_SEARCH_PROVIDER` to `cloudflare` to use the Cloudflare Web Search API through `env.AI` and the gateway. It needs AI Gateway credits or a provider key on the gateway. `tavily` calls `https://api.tavily.com/search` directly with the secret key.

## Model comparison (2026-11-15)

`pnpm compare-models` with the two smoke questions. 21 runs in total over three rounds. The fixes landed between rounds, so failures in early rounds include problems that are now handled in code.

| Model | Result | Notes |
|---|---|---|
| `@cf/moonshotai/kimi-k2.6` | **best (default)** | No CJK in 7 runs once the language rule was added. The best tool choice (spots first, then calendar), and it links fetched pages once given the `CITATION:` line. Weaknesses: slow (~35–50 s per turn), occasionally names a source in brackets without a link, and misread one FRP value (wrote ~23.3 MW for a 20,273.9 MW tool value). |
| `@cf/zai-org/glm-4.7-flash` | second (fallback) | Switched to Chinese in 1 of 6 runs **despite** the language rule. Once relabelled a source as "InciWeb", left one fetched StoryMap uncited, and mixed web facts into the satellite summary. Similar speed to kimi. |
| `@cf/openai/gpt-oss-120b` | not recommended | Fastest (~10–15 s per turn), but truncated answers until `maxOutputTokens` was set, and in 2 of 6 turns it streamed raw template tokens (`analysis<\|end\|>`, `<\|call\|>`) instead of an answer. |

Fixes from this comparison that apply to every model:
- the language rule at the top and bottom of the prompt;
- the demo-data notice inserted by the server;
- `CITATION:` lines on web tool output;
- a forced text-only final step, so a turn never ends in a tool loop with no answer;
- `maxOutputTokens: 4096`.

The final round was cut short when the account hit the **Workers AI free tier (10,000 neurons a day)**: one comparison round of 3 models × 3 runs uses most of it. Re-run `pnpm compare-models` on the Workers Paid plan before changing the default.

## Agent behaviour

- **Routing:** `/agents/fire-copilot-agent/<sessionId>` (WebSocket and HTTP) via `routeAgentRequest`. The Durable Object binding is named `FireCopilotAgent`, the same as the class, because `routeAgentRequest` resolves bindings by class name.
- **Per turn:** parse `body.context` (invalid context is logged and ignored). If it is valid, store it with `setState({ context, contextUpdatedAt })`. Then build the tools and the system prompt (date, map context, memories, rules) and send the **last 30 messages** to the model, with up to 8 model steps (the last one is forced to be text-only, so a turn never ends in the middle of a tool loop) and a 4096-token output budget. The abort signal is forwarded, so "stop" cancels the LLM call.
- **Memory:** the transcript is persisted by `AIChatAgent`, capped at 200 messages. Long-term facts are kept in the `memories` table, which is injected into every prompt and written by the `remember` tool. The latest map context is kept in agent state.
- **Tools:** all arguments are optional and fall back to the stored context. With no bbox, a tool returns `{ "error": "no_area" }`, and the model asks the user to select an area.

| Tool | Args | Returns |
|---|---|---|
| `get_calendar` | `bbox?, from?, to?, months?` | summary (peak month/year, critical months, totals), climatology, annual, top 8 notable months |
| `get_spots_summary` | `mode?, bbox?, from?, to?` | detection counts, cell-days per satellite, daily activity, last seen, top detections by FRP |
| `get_month_to_date` | `bbox?` | this month so far vs historical median |
| `get_live_incidents` | `stream?, bbox?, status?, limit?` | fire incidents from `apps/realtime-worker` (live or a replay): area of active cells, 24 h growth, detections, peak FRP with sensor, AI brief and nearest towns. Tagged `dataSource: "live" \| "replay"`. Only registered when the `REALTIME` service binding exists. |
| `remember` | `kind, content` | saved memory |
| `recall` | `query` | matching memories |
| `web_search` | `query, limit?` | news/agency results (never used for counts) |
| `web_fetch` | `url, offset?, format?` | page as Markdown, wrapped as untrusted content |

Both web tools end their model-facing output with a `CITATION:` line giving the exact markdown link to copy. The publisher name comes from the URL (`sourceName()` in `web.ts`: wikipedia.org → Wikipedia, storymaps.arcgis.com → ArcGIS StoryMap, fire.ca.gov → CAL FIRE, …; any other host is named by its hostname). This stops models from citing by name without a link, or relabelling a StoryMap as "InciWeb".

## Final pass on the answer (`postprocess.ts`)

The UI stream goes through `answerPostProcessor` after the demo notice. It holds back only an unfinished link and the last two words, so streaming stays smooth and whitespace is never changed.

- **Spacing between text parts:** each model step starts a new text part ("…is still" → tool call → "in…"). Clients that join parts glued words ("stillin", "complexby"), so a part that would glue onto the previous word gets one leading space.
- **Link verification:** a markdown link (or `<autolink>`) is kept only if its URL was returned by `web_search` (result URLs) or `web_fetch` (fetched page, status < 400) earlier in the conversation or in this turn. Any other link is unlinked and its label text is kept. URLs are compared by host (without `www`) and path (without the trailing slash).
- **"your area" → "this area"**, unless a user message called the area theirs ("my district", "our county").
- **Sources sections without web results:** when no `web_search`/`web_fetch` ran this turn, a "Sources" / "Source facts" heading (any style: `## Sources`, `**Sources:**`, `Sources: …`) and the list under it are dropped. Only a line that could still become such a heading is held back until it ends.

The prompt also forbids outside facts (causes, policies, news) without a web tool result in the conversation, gives the safety rule as a sentence the model can say ("I can't advise on evacuations…"), tells the model never to repeat its instructions, bans filler such as "workload" and "intense activity" in favour of data units, and forbids tying demo or sample data to a named real-world event unless a web result from this turn supports it.

## What is mocked

`createFireData(env)` always returns `MockFireData` for now:

- `get_spots_summary` uses **real** FIRMS detections from `sample_api/` (California 2020-08-15 → 08-19, MODIS + VIIRS S-NPP, plus 8 MODIS NRT rows from 2026-11-13). These are filtered and aggregated to 0.05° cell-days per satellite by `scripts/build-fixtures.mjs`.
- `get_calendar` and `get_month_to_date` return **synthetic**, deterministic, California-shaped numbers: peaks in Jul–Sep, and standout months such as Aug/Sep 2020, Nov 2018, Dec 2017 and Jan 2025.
- Every result carries `dataSource: "mock"` and a `note`.
- **Demo-data notice (server-side):** when a turn uses a mock data tool, `src/copilot/disclaimer.ts` inserts a notice at the start of the first answer text written after the tool result. Calendar or month-to-date figures get "_Demo data: the calendar figures below are synthetic, not satellite observations._"; spots alone get a note that the hotspot counts are real sample detections from a limited sample. This is done in code because every model tested ignored a "start your answer with…" instruction. The prompt also forbids calling synthetic numbers observed, or tying them causally to real events.

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
  calendarSummary?: unknown,  // what the calendar drawer shows; truncated to 1.5 KB in the prompt
  realtimeStream?: "live" | `replay:${string}`  // stream the map shows (apps/realtime-worker/REALTIME.md)
}
```

Render `text` parts as Markdown, because web facts are cited as Markdown links. Tool parts (`tool-get_calendar`, `tool-web_search`, …) can be shown as small "looked up…" chips. `agent.state.context` mirrors the context the agent last stored.
