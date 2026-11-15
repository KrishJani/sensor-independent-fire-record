import { WebSearchError, type WebSearchResponse, type WebSearchSource } from "agents/websearch";
import { webFetchTool } from "agents/webfetch/ai-sdk";
import { webSearchTool } from "agents/websearch/ai-sdk";
import type { ToolSet } from "ai";

/** Web tools: web_fetch is always on; web_search uses Tavily or Cloudflare Web Search. */

export const WEB_SEARCH_DESCRIPTION = [
  "Search the public web for context our satellite record cannot give: fire news, names, containment, evacuations, causes, weather and wind, smoke and air quality, and official agency updates (CAL FIRE, InciWeb, NIFC, CIFFC, NASA, NOAA).",
  "NEVER use it for hotspot counts, cell-days, FRP or any number about fire activity: those come only from get_calendar, get_spots_summary and get_month_to_date.",
  "Prefer official sources; include the date in time-sensitive queries.",
  "There is no next page: rephrase and search again for more results. To read a result, fetch its URL with web_fetch."
].join(" ");

const TAVILY_URL = "https://api.tavily.com/search";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}
interface TavilyResponse {
  query?: string;
  results?: TavilyResult[];
  response_time?: number | string;
  request_id?: string;
}

/** Map Tavily's /search response to the Web Search API shape the tool renders. */
export function mapTavilyResponse(query: string, body: TavilyResponse): WebSearchResponse {
  const items = (body.results ?? [])
    .filter((r): r is TavilyResult & { url: string } => typeof r.url === "string" && r.url.length > 0)
    .map((r) => ({
      url: r.url,
      title: r.title?.trim() || r.url,
      ...(r.content ? { description: r.content } : {}),
      ...(r.published_date ? { lastModifiedDate: r.published_date } : {})
    }));
  const seconds = Number(body.response_time ?? 0);
  return {
    items,
    metadata: {
      query: body.query ?? query,
      requestId: body.request_id ?? "",
      latencyMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0
    }
  };
}

/** Turn a non-2xx Tavily response into a WebSearchError the tool understands. */
export function tavilyError(status: number, detail: string): WebSearchError {
  const d = detail ? `: ${detail.slice(0, 300)}` : "";
  switch (status) {
    case 401:
      return new WebSearchError(`Tavily rejected the API key (401). Check TAVILY_API_KEY${d}`, {
        status,
        code: "web_search_unauthorized",
        retryable: false
      });
    case 432:
    case 433:
      return new WebSearchError(`Tavily plan or credit limit reached (${status})${d}`, {
        status,
        code: "web_search_payment_required",
        retryable: false
      });
    case 429:
      return new WebSearchError(`Tavily rate limit hit (429)${d}`, {
        status,
        code: "web_search_rate_limited",
        retryable: true
      });
    case 400:
      return new WebSearchError(`Tavily rejected the query (400)${d}`, {
        status,
        code: "invalid_web_search_input",
        retryable: false
      });
    default:
      return new WebSearchError(`Tavily search failed (${status})${d}`, {
        status,
        code: "web_search_unavailable",
        retryable: status >= 500
      });
  }
}

export function createTavilySource(apiKey: string, fetchImpl: typeof fetch = fetch): WebSearchSource {
  return {
    async search({ query, limit = 5 }, options) {
      let res: Response;
      try {
        res = await fetchImpl(TAVILY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            query,
            max_results: limit,
            search_depth: "basic",
            topic: "general",
            include_published_date: true
          }),
          signal: options?.signal
        });
      } catch (err) {
        if (options?.signal?.aborted) throw err;
        throw new WebSearchError("Could not reach Tavily", {
          status: 503,
          code: "web_search_unavailable",
          retryable: true,
          cause: err
        });
      }
      if (!res.ok) throw tavilyError(res.status, await res.text().catch(() => ""));
      return mapTavilyResponse(query, (await res.json()) as TavilyResponse);
    }
  };
}

let warnedNoKey = false;

export function createWebTools(env: Env): ToolSet {
  const web_fetch = webFetchTool({ binding: env.AI, pageChars: 12_000 });

  const provider = (env.WEB_SEARCH_PROVIDER || "tavily").toLowerCase();
  if (provider === "cloudflare") {
    return {
      web_search: webSearchTool({
        binding: env.AI,
        gateway: env.AI_GATEWAY_ID,
        description: WEB_SEARCH_DESCRIPTION
      }),
      web_fetch
    };
  }

  if (!env.TAVILY_API_KEY) {
    if (!warnedNoKey) {
      console.warn(
        "[copilot] WEB_SEARCH_PROVIDER=tavily but TAVILY_API_KEY is not set: web_search is disabled (web_fetch still works)."
      );
      warnedNoKey = true;
    }
    return { web_fetch };
  }

  return {
    web_search: webSearchTool({
      source: createTavilySource(env.TAVILY_API_KEY),
      description: WEB_SEARCH_DESCRIPTION
    }),
    web_fetch
  };
}
