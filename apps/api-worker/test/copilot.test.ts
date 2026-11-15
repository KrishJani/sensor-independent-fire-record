import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseContext } from "../src/copilot/context";
import { MAX_MEMORIES, MemoryStore, type SqlTag } from "../src/copilot/memory";
import { createTavilySource, mapTavilyResponse, tavilyError } from "../src/copilot/web";
import { MockFireData } from "../src/data/mockFireData";

const CA: [number, number, number, number] = [-124.5, 32.5, -114.0, 42.1];
const mock = new MockFireData();

describe("MockFireData", () => {
  it("calendar is deterministic, labelled mock, and peaks in fire season", async () => {
    const q = { bbox: CA, from: "2000-11-01", to: "2025-12-31" };
    const a = await mock.getCalendar(q);
    const b = await mock.getCalendar(q);
    expect(a).toEqual(b);
    expect(a.dataSource).toBe("mock");
    expect(a.note).toMatch(/SYNTHETIC/);
    expect(a.summary.criticalMonths).toEqual(expect.arrayContaining([7, 8, 9]));
    expect(a.notableMonths.length).toBeLessThanOrEqual(8);
    const notable = a.notableMonths.map((m) => `${m.year}-${m.month}`);
    expect(notable).toEqual(expect.arrayContaining(["2020-8", "2018-11", "2017-12"]));
  });

  it("marks pre-2012 months as calibrated MODIS estimates and Aug 2020 as a record", async () => {
    const r = await mock.getCalendar({ bbox: CA, from: "2005-01-01", to: "2020-12-31", months: [8] });
    expect(r.notableMonths.every((m) => m.month === 8)).toBe(true);
    const aug2020 = r.notableMonths.find((m) => m.year === 2020)!;
    expect(aug2020.anomaly.class).toBe("record_high");
    expect(aug2020.peakFrpSensor).toBe("VIIRS");
    const early = (await mock.getCalendar({ bbox: CA, from: "2005-08-01", to: "2005-08-31" })).notableMonths[0]!;
    expect(early.calibratedEstimate).toBe(true);
    expect(early.sourceMix).toBe(0);
    expect(early.peakFrpSensor).toBe("MODIS");
  });

  it("flags partial months as incomplete and returns zeros outside California", async () => {
    const partial = await mock.getCalendar({ bbox: CA, from: "2020-08-10", to: "2020-08-20" });
    expect(partial.notableMonths[0]!.complete).toBe(false);
    const outside = await mock.getCalendar({ bbox: [10, 10, 11, 11], from: "2020-01-01", to: "2020-12-31" });
    expect(outside.summary.totalHarmonizedCellDays).toBe(0);
    expect(outside.note).toMatch(/outside/);
  });

  it("spots summary uses the real Aug 2020 sample", async () => {
    const r = await mock.getSpotsSummary({ mode: "archival", bbox: CA, from: "2020-08-01", to: "2020-08-31" });
    expect(r.counts.detections).toBeGreaterThan(15_000);
    expect(r.daily.map((d) => d.date)).toEqual([
      "2020-08-15",
      "2020-08-16",
      "2020-08-17",
      "2020-08-18",
      "2020-08-19"
    ]);
    expect(Object.keys(r.counts.bySatellite).sort()).toEqual(["AQUA", "SNPP", "TERRA"]);
    expect(r.topDetections[0]!.frpMw).toBeGreaterThanOrEqual(r.topDetections[1]!.frpMw);
    expect(r.lastSeen).toMatch(/^2020-08-19T\d\d:\d\d:00Z$/);
    expect(r.note).toMatch(/REAL/);
  });

  it("spots summary separates realtime rows and is empty outside the sample", async () => {
    const rt = await mock.getSpotsSummary({ mode: "realtime", bbox: CA, from: "2026-11-01", to: "2026-11-15" });
    expect(rt.counts.detections).toBe(8);
    const empty = await mock.getSpotsSummary({ mode: "archival", bbox: CA, from: "2019-01-01", to: "2019-12-31" });
    expect(empty.counts.detections).toBe(0);
    expect(empty.lastSeen).toBeNull();
  });

  it("month-to-date is deterministic for a given day", async () => {
    const a = await mock.getMonthToDate({ bbox: CA, today: "2026-11-15" });
    expect(a).toEqual(await mock.getMonthToDate({ bbox: CA, today: "2026-11-15" }));
    expect(a.month).toBe("2026-11");
    expect(a.throughDay).toBe(14);
    expect(a.daily).toHaveLength(14);
  });
});

describe("Tavily mapping", () => {
  it("maps results and metadata to the Web Search API shape", () => {
    const out = mapTavilyResponse("august complex", {
      query: "august complex fire",
      response_time: 1.23,
      request_id: "req-1",
      results: [
        { title: "August Complex", url: "https://www.fire.ca.gov/a", content: "Largest fire", published_date: "2020-09-10" },
        { title: "", url: "https://inciweb.wildfire.gov/b" },
        { title: "no url" }
      ]
    });
    expect(out).toEqual({
      items: [
        {
          url: "https://www.fire.ca.gov/a",
          title: "August Complex",
          description: "Largest fire",
          lastModifiedDate: "2020-09-10"
        },
        { url: "https://inciweb.wildfire.gov/b", title: "https://inciweb.wildfire.gov/b" }
      ],
      metadata: { query: "august complex fire", requestId: "req-1", latencyMs: 1230 }
    });
  });

  it("maps HTTP errors to WebSearchError codes", () => {
    expect(tavilyError(401, "").code).toBe("web_search_unauthorized");
    expect(tavilyError(432, "").code).toBe("web_search_payment_required");
    const rl = tavilyError(429, "slow down");
    expect(rl.code).toBe("web_search_rate_limited");
    expect(rl.retryable).toBe(true);
  });

  it("sends the documented request", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ results: [], response_time: 0.5, request_id: "r" }));
    }) as unknown as typeof fetch;
    await createTavilySource("tvly-test", fakeFetch).search({ query: "q", limit: 3 });
    expect(seen!.url).toBe("https://api.tavily.com/search");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer tvly-test");
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      query: "q",
      max_results: 3,
      search_depth: "basic",
      topic: "general",
      include_published_date: true
    });
  });
});

describe("MemoryStore", () => {
  const makeStore = () => {
    const db = new DatabaseSync(":memory:");
    const sql: SqlTag = (strings, ...values) => {
      const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? "?" : ""), "");
      const stmt = db.prepare(query);
      const args = values.map((v) => (typeof v === "boolean" ? Number(v) : v));
      return /^\s*(select|with)/i.test(query) ? (stmt.all(...args) as never[]) : (stmt.run(...args), []);
    };
    const store = new MemoryStore(sql);
    store.init();
    return store;
  };

  it("dedupes, searches by keyword and caps rows", () => {
    const m = makeStore();
    m.remember("aoi", "My district is Butte County, bbox [-122.1, 39.3, -121.0, 40.2]");
    const dup = m.remember("aoi", "  my district is butte county, BBOX [-122.1, 39.3, -121.0, 40.2] ");
    expect(dup.duplicate).toBe(true);
    m.remember("preference", "Prefers metric units");
    expect(m.list()).toHaveLength(2);
    expect(m.search("butte district")[0]!.kind).toBe("aoi");
    expect(m.search("zzz")).toHaveLength(0);
    for (let i = 0; i < MAX_MEMORIES + 10; i++) m.remember("finding", `finding number ${i}`);
    expect(m.list()).toHaveLength(MAX_MEMORIES);
  });
});

describe("parseContext", () => {
  it("accepts valid context and ignores invalid context", () => {
    const ok = parseContext({
      tab: "archival",
      aoi: { bbox: [-123, 39, -122, 40], label: "Mendocino" },
      from: "2020-08-01",
      to: "2020-08-31"
    });
    expect(ok?.aoi?.label).toBe("Mendocino");
    expect(parseContext({ tab: "archival", aoi: { bbox: [1, 2, 0, 1] }, from: "x", to: "y" })).toBeNull();
    expect(parseContext(undefined)).toBeNull();
  });
});
