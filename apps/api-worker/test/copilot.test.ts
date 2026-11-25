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

describe("system prompt", async () => {
  const { buildSystemPrompt, LANGUAGE_RULE } = await import("../src/copilot/prompt");
  const base = { today: "2026-11-15", context: null, memories: [], webSearchEnabled: true };

  it("states the language rule at the top and the bottom", () => {
    const p = buildSystemPrompt({ ...base, dataSource: "mock" });
    expect(p.startsWith(LANGUAGE_RULE)).toBe(true);
    expect(p.trimEnd().endsWith(LANGUAGE_RULE)).toBe(true);
  });

  it("includes mock honesty rules only for mock data", () => {
    expect(buildSystemPrompt({ ...base, dataSource: "mock" })).toMatch(/SYNTHETIC numbers/);
    expect(buildSystemPrompt({ ...base, dataSource: "live" })).not.toMatch(/SYNTHETIC/);
  });

  it("covers tool choice, citations and 'this area'", () => {
    const p = buildSystemPrompt({ ...base, dataSource: "live" });
    expect(p).toMatch(/get_spots_summary FIRST/);
    expect(p).toMatch(/web_fetch/);
    expect(p).toMatch(/arcgis\.com StoryMap/);
    expect(p).toMatch(/Never write "your area"/);
  });

  it("words the safety rule so it can be said, and never as 'You never…'", () => {
    const p = buildSystemPrompt({ ...base, dataSource: "mock" });
    expect(p).toMatch(/I can't advise on evacuations/);
    expect(p).not.toMatch(/^- You never/m);
    expect(p).toMatch(/No outside facts without a web tool result/);
    expect(p).toMatch(/workload/);
    expect(p).toMatch(/intense activity/);
    expect(p).toMatch(/Never tie demo or sample data .* to a named real-world event/);
  });
});

describe("web citations", async () => {
  const { sourceName, fetchCitationNote, searchCitationNote } = await import("../src/copilot/web");

  it("names sources by their real publisher", () => {
    expect(sourceName("https://en.wikipedia.org/wiki/August_Complex_fire")).toBe("Wikipedia");
    expect(sourceName("https://storymaps.arcgis.com/stories/1a0a")).toBe("ArcGIS StoryMap");
    expect(sourceName("https://www.fire.ca.gov/incidents/2020")).toBe("CAL FIRE");
    expect(sourceName("https://earthobservatory.nasa.gov/images/1")).toBe("NASA Earth Observatory");
    expect(sourceName("https://www.example-news.com/a")).toBe("example-news.com");
  });

  it("gives the model an exact link to copy", () => {
    expect(fetchCitationNote({ url: "https://a.org/x", finalUrl: "https://en.wikipedia.org/wiki/X" })).toContain(
      "[Wikipedia](https://en.wikipedia.org/wiki/X)"
    );
    const note = searchCitationNote({ items: [{ url: "https://storymaps.arcgis.com/stories/1" }] })!;
    expect(note).toContain("1. [ArcGIS StoryMap](https://storymaps.arcgis.com/stories/1)");
    expect(searchCitationNote({ items: [] })).toBeNull();
  });
});

describe("demo disclaimer transform", async () => {
  const { demoDisclaimerTransform, SYNTHETIC_NOTICE, SAMPLE_NOTICE } = await import("../src/copilot/disclaimer");
  type Chunk = import("ai").UIMessageChunk;

  async function run(chunks: Chunk[]): Promise<Chunk[]> {
    const out: Chunk[] = [];
    const rs = new ReadableStream<Chunk>({
      start(c) {
        chunks.forEach((x) => c.enqueue(x));
        c.close();
      }
    }).pipeThrough(demoDisclaimerTransform());
    for await (const ch of rs as unknown as AsyncIterable<Chunk>) out.push(ch);
    return out;
  }
  const tool = (id: string, name: string, output: unknown): Chunk[] => [
    { type: "tool-input-available", toolCallId: id, toolName: name, input: {} } as Chunk,
    { type: "tool-output-available", toolCallId: id, output } as Chunk
  ];
  const text = (id: string, delta: string): Chunk[] => [
    { type: "text-start", id } as Chunk,
    { type: "text-delta", id, delta } as Chunk,
    { type: "text-end", id } as Chunk
  ];
  const texts = (cs: Chunk[]) => cs.filter((c) => c.type === "text-delta").map((c) => (c as { delta: string }).delta);

  it("prepends the synthetic notice once, right after the first post-tool text-start", async () => {
    const out = await run([
      ...tool("1", "get_spots_summary", { dataSource: "mock" }),
      ...tool("2", "get_calendar", { dataSource: "mock" }),
      ...text("t1", "Answer."),
      ...text("t2", "More.")
    ]);
    const deltas = texts(out);
    expect(deltas[0]).toContain(SYNTHETIC_NOTICE);
    expect(deltas[0]).toMatch(/real NASA FIRMS sample/);
    expect(deltas.slice(1)).toEqual(["Answer.", "More."]);
  });

  it("uses the sample notice for spots only, and nothing for web-only or live turns", async () => {
    expect(texts(await run([...tool("1", "get_spots_summary", { dataSource: "mock" }), ...text("t", "x")]))[0]).toContain(
      SAMPLE_NOTICE
    );
    expect(texts(await run([...tool("1", "web_search", { items: [] }), ...text("t", "x")]))).toEqual(["x"]);
    expect(texts(await run([...tool("1", "get_calendar", { dataSource: "live" }), ...text("t", "x")]))).toEqual(["x"]);
  });

  it("preserves whitespace at delta boundaries when injecting", async () => {
    const deltas = ["The fire was still ", "in", " August, and ", "detections ", "(4,236) peaked."];
    const out = await run([
      ...tool("1", "get_calendar", { dataSource: "mock" }),
      { type: "text-start", id: "t" } as Chunk,
      ...deltas.map((delta) => ({ type: "text-delta", id: "t", delta }) as Chunk),
      { type: "text-end", id: "t" } as Chunk
    ]);
    expect(texts(out).join("")).toBe(`${SYNTHETIC_NOTICE}\n\n${deltas.join("")}`);
    expect(texts(out).slice(1)).toEqual(deltas);
  });

  it("does not attach the notice to narration written before any tool ran", async () => {
    const deltas = texts(
      await run([...text("t0", "Looking…"), ...tool("1", "get_calendar", { dataSource: "mock" }), ...text("t1", "Answer.")])
    );
    expect(deltas[0]).toBe("Looking…");
    expect(deltas[1]).toContain(SYNTHETIC_NOTICE);
  });
});

describe("answer post-processor", async () => {
  const pp = await import("../src/copilot/postprocess");
  type Chunk = import("ai").UIMessageChunk;

  async function run(chunks: Chunk[], opts?: Parameters<typeof pp.answerPostProcessor>[0]): Promise<string> {
    const rs = new ReadableStream<Chunk>({
      start(c) {
        chunks.forEach((x) => c.enqueue(x));
        c.close();
      }
    }).pipeThrough(pp.answerPostProcessor(opts));
    let text = "";
    for await (const ch of rs as unknown as AsyncIterable<Chunk>) if (ch.type === "text-delta") text += ch.delta;
    return text;
  }
  const part = (id: string, ...deltas: string[]): Chunk[] => [
    { type: "text-start", id } as Chunk,
    ...deltas.map((delta) => ({ type: "text-delta", id, delta }) as Chunk),
    { type: "text-end", id } as Chunk
  ];
  const tool = (id: string, name: string, output: unknown): Chunk[] => [
    { type: "tool-input-available", toolCallId: id, toolName: name, input: {} } as Chunk,
    { type: "tool-output-available", toolCallId: id, output } as Chunk
  ];

  it("keeps whitespace exactly and spaces text parts that would glue", async () => {
    const text = await run([
      ...part("a", "The fire is ", "still"),
      ...tool("1", "get_spots_summary", {}),
      ...part("b", "in August, with ", "detections", "(4,236) and\n\n- a  list")
    ]);
    expect(text).toBe("The fire is still in August, with detections(4,236) and\n\n- a  list");
  });

  it("removes made-up bare URLs and the Citation/Source lines they leave empty (streamed in pieces)", async () => {
    const text = await run(
      part("a", "The largest fire grew 120 km2.\nCita", "tion: https://www.fire", "watch.example/q", "uebec-2023\n", "Details at https://made.up/x. Done.\n- **Source:** <https://nope.example/a>\nEnd")
    );
    expect(text).toBe("The largest fire grew 120 km2.\nDetails at . Done.\nEnd");
  });

  it("keeps bare URLs a web tool returned, and their Citation line", async () => {
    const text = await run([
      ...tool("1", "web_search", { items: [{ url: "https://www.cbc.ca/news/quebec-fires" }] }),
      ...part("a", "Evacuations were ordered.\nCitation: https://cbc.ca/news/quebec-fires\n")
    ]);
    expect(text).toBe("Evacuations were ordered.\nCitation: https://cbc.ca/news/quebec-fires\n");
  });

  it("leaves URLs inside markdown links to the link filter", async () => {
    expect(pp.removeUnknownBareUrls("see [CBC](https://cbc.ca/x) and <https://y.example>", new Set())).toBe("see [CBC](https://cbc.ca/x) and <https://y.example>");
  });

  it("does not add a space when either side already has whitespace", async () => {
    expect(await run([...part("a", "One.\n"), ...part("b", "Two.")])).toBe("One.\nTwo.");
    expect(await run([...part("a", "One."), ...part("b", " Two.")])).toBe("One. Two.");
  });

  it("unlinks URLs no web tool returned and keeps returned ones, even split across deltas", async () => {
    const text = await run([
      ...tool("1", "web_search", { items: [{ url: "https://www.fire.ca.gov/incidents/2020/8/16/august-complex/" }] }),
      ...tool("2", "web_fetch", { url: "https://a.org/x", finalUrl: "https://en.wikipedia.org/wiki/August_Complex_fire", status: 200 }),
      ...part(
        "t",
        "Per [CAL FIRE](https://fire.ca.gov/incidents/2020/8/16/aug",
        "ust-complex) and [Wiki",
        "pedia](https://en.wikipedia.org/wiki/August_Complex_fire), not [NIFC](https://nifc.gov/made-up) or <https://x.com/y>."
      )
    ]);
    expect(text).toBe(
      "Per [CAL FIRE](https://fire.ca.gov/incidents/2020/8/16/august-complex) and [Wikipedia](https://en.wikipedia.org/wiki/August_Complex_fire), not NIFC or ."
    );
  });

  it("drops a fetched page that failed, and accepts URLs from earlier turns", async () => {
    expect(await run([...tool("1", "web_fetch", { url: "https://a.org/p", status: 404 }), ...part("t", "[A](https://a.org/p)")])).toBe("A");
    expect(await run(part("t", "[A](https://a.org/p)"), { knownUrls: ["https://www.a.org/p/"] })).toBe("[A](https://a.org/p)");
  });

  it("rewrites 'your area' (also split across deltas) unless the user owns the area", async () => {
    expect(await run(part("t", "Your area had 3 cell-days; in your", " area it is quiet."))).toBe(
      "This area had 3 cell-days; in this area it is quiet."
    );
    expect(await run(part("t", "In your area."), { rewriteArea: false })).toBe("In your area.");
  });

  const body = "Answer: 316 cell-days.\n\n- 4,704 detections\n";
  const sources = "\n## Sources\n- NASA FIRMS spots summary (archival)\n  bundled sample\n- get_calendar\n";

  it("strips a Sources section when no web tool ran this turn, even split across deltas", async () => {
    const chunks = (body + sources + "\nThat is all.").match(/[\s\S]{1,7}/g)!;
    expect(await run([...tool("1", "get_calendar", {}), ...part("t", ...chunks)])).toBe(body + "\nThat is all.");
  });

  it("recognises other Sources heading styles, and leaves sentences about sources alone", async () => {
    for (const h of ["**Sources:**", "Source facts:", "Sources: NASA FIRMS sample", "### Source", "__Sources__"])
      expect(await run(part("t", `${body}${h}\n- a\n- b`))).toBe(body);
    const prose = "Sources show 3 cell-days.\nSourcesmith is a name.\n";
    expect(await run(part("t", prose))).toBe(prose);
  });

  it("keeps the Sources section when a web tool ran this turn", async () => {
    const text = `${body}\n**Sources:**\n- [Wikipedia](https://en.wikipedia.org/wiki/X)\n`;
    expect(
      await run([...tool("1", "web_fetch", { url: "https://en.wikipedia.org/wiki/X", status: 200 }), ...part("t", text)])
    ).toBe(text);
  });

  it("collects web URLs and area ownership from the transcript", () => {
    const messages = [
      { id: "1", role: "user", parts: [{ type: "text", text: "How is my district doing?" }] },
      {
        id: "2",
        role: "assistant",
        parts: [
          { type: "tool-web_search", toolCallId: "a", state: "output-available", input: {}, output: { items: [{ url: "https://n.org/1" }] } },
          { type: "tool-web_fetch", toolCallId: "b", state: "output-available", input: {}, output: { url: "https://n.org/2", status: 200 } },
          { type: "tool-get_calendar", toolCallId: "c", state: "output-available", input: {}, output: { url: "https://no.org" } }
        ]
      }
    ] as unknown as import("ai").UIMessage[];
    expect(pp.collectWebUrls(messages)).toEqual(["https://n.org/1", "https://n.org/2"]);
    expect(pp.userOwnsArea(messages)).toBe(true);
    expect(pp.userOwnsArea(messages.slice(1))).toBe(false);
  });
});

describe("get_live_incidents (realtime service binding)", async () => {
  const { getLiveIncidents } = await import("../src/copilot/realtime");
  const incident = {
    id: "replay-abc123def0.4",
    status: "active",
    significant: true,
    mergedInto: null,
    detections: 3550,
    cells: 71,
    affectedAreaKm2: 1718.9,
    frpMaxMw: 6718,
    frpMaxSensor: "VIIRS",
    firstSeen: Date.UTC(2020, 7, 18, 6, 7),
    lastSeen: Date.UTC(2020, 7, 19, 21, 42),
    centroid: [-122.209, 38.551],
    bbox: [-122.55, 38.3, -121.98, 38.88],
    growthKm2PerDay: 1621.9,
    sensors: { VIIRS: 3168, MODIS: 382 }
  };
  const calls: string[] = [];
  const fake = {
    async fetch(url: string) {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname.startsWith("/realtime/replay/")) return Response.json({ scenario: "quebec-2023-06", status: "running", progress: 0.42, streamT: Date.UTC(2023, 5, 3, 10) });
      if (u.pathname === "/realtime/incidents") return Response.json({ streamT: Date.UTC(2020, 7, 19, 22), count: 1, incidents: [incident] });
      if (u.pathname.startsWith("/realtime/incidents/"))
        return Response.json({
          brief: { text: "The fire covers 1718.9 km2." },
          enrichment: { places: { status: "ok", data: [{ name: "Napa", distanceKm: 12.1, direction: "SW" }] } }
        });
      return new Response("nope", { status: 404 });
    }
  };
  const ctx = { tab: "realtime" as const, aoi: { bbox: [-123, 38, -121, 39] as [number, number, number, number] }, from: "2020-08-15", to: "2020-08-19" };

  it("defaults to the map bbox and live stream, tags dataSource", async () => {
    calls.length = 0;
    const r = (await getLiveIncidents(fake, {}, ctx)) as Record<string, any>;
    expect(r.dataSource).toBe("live");
    expect(r.stream).toBe("live");
    expect(calls[0]).toContain("bbox=-123%2C38%2C-121%2C39");
    expect(calls[0]).toContain("stream=live");
    expect(r.incidents[0]).toMatchObject({ gridCoverageKm2: 1718.9, name: "near Napa", peakFrp: "6718 MW (VIIRS)", brief: "The fire covers 1718.9 km2.", nearestPlaces: ["Napa (12.1 km SW)"] });
  });

  it("never returns internal ids, and uses the shared current weather reading", async () => {
    const withWeather = {
      async fetch(url: string) {
        const u = new URL(url);
        if (u.pathname === "/realtime/incidents") return Response.json({ streamT: Date.UTC(2026, 10, 25, 9), count: 1, incidents: [{ ...incident, id: "live.2278", activity: "cooling" }] });
        return Response.json({
          brief: { text: "Near Stanton, , the fire is steady." },
          weatherNow: { time: "2026-11-25T09:00", windSpeedKmh: 14, windFrom: "NW", relativeHumidityPct: 40, temperatureC: 9 },
          enrichment: { places: { status: "ok", data: [{ name: "Stanton", distanceKm: 3, direction: "N" }] }, weather: { status: "ok", data: { time: "2026-11-22T08:00", windSpeedKmh: 1, windFrom: "S", relativeHumidityPct: 1, temperatureC: 1 } } }
        });
      }
    };
    const r = (await getLiveIncidents(withWeather, {}, ctx)) as Record<string, any>;
    expect(JSON.stringify(r)).not.toMatch(/live\.2278|"id"/);
    expect(r.incidents[0]).toMatchObject({ activity: "cooling", brief: "Near Stanton, the fire is steady.", weather: { time: "2026-11-25T09:00", windKmh: 14 } });
    expect(r.note).toMatch(/grid coverage/);
  });

  it("accepts a replay stream (from args or context) and labels it as a replay", async () => {
    const r = (await getLiveIncidents(fake, {}, { ...ctx, realtimeStream: "replay:abc123def0" })) as Record<string, any>;
    expect(r.dataSource).toBe("replay");
    expect(r.replay).toEqual({ scenario: "quebec-2023-06", status: "running", progress: 0.42, clock: "2023-06-03T10:00Z" });
    expect(r.note).toMatch(/REPLAY/);
    const bad = (await getLiveIncidents(fake, { stream: "replay:../x" }, ctx)) as Record<string, any>;
    expect(bad.error).toBe("bad_stream");
  });

  it("uses the map's replay stream even when the model passes stream live", async () => {
    calls.length = 0;
    const r = (await getLiveIncidents(fake, { stream: "live" }, { ...ctx, realtimeStream: "replay:abc123def0" })) as Record<string, any>;
    expect(r.stream).toBe("replay:abc123def0");
    expect(r.streamNote).toMatch(/ignored/);
    expect(calls.find((c) => c.includes("/realtime/incidents?"))).toContain("stream=replay%3Aabc123def0");
  });

  it("an empty replay result gives the replay clock and says nothing detected yet", async () => {
    const empty = {
      async fetch(url: string) {
        const u = new URL(url);
        if (u.pathname.startsWith("/realtime/replay/")) return Response.json({ scenario: "quebec-2023-06", status: "running", progress: 0.02, streamT: Date.UTC(2023, 5, 1, 6) });
        if (u.pathname === "/realtime/incidents") return Response.json({ streamT: Date.UTC(2023, 5, 1, 6), count: 0, incidents: [] });
        return new Response("nope", { status: 404 });
      }
    };
    const r = (await getLiveIncidents(empty, {}, { ...ctx, aoi: null, realtimeStream: "replay:abc123def0" })) as Record<string, any>;
    expect(r.count).toBe(0);
    expect(r.emptyReason).toBe("none_detected_yet");
    expect(r.answerHint).toContain("Replay clock 2023-06-01T06:00Z");
    expect(r.answerHint).toMatch(/nothing has been detected|No significant incident has been detected/);
    expect(r.answerHint).toMatch(/Do not say "there are no fires"/);
  });

  it("places: names, none within radius, or unavailable", async () => {
    const { describePlaces } = await import("../src/copilot/realtime");
    expect(describePlaces({ status: "ok", data: [{ name: "Lebel-sur-Quévillon", place: "village", distanceKm: 45.2, direction: "W" }] })).toEqual(["Lebel-sur-Quévillon (village, 45.2 km W)"]);
    expect(describePlaces({ status: "ok", data: [], radiusKm: 75 })).toBe("none within 75 km");
    expect(describePlaces({ status: "failed", error: "timeout" })).toMatch(/^unavailable/);
  });
});

describe("chat model fallback", async () => {
  const { chatFallbacks, DEFAULT_FALLBACK_MODEL } = await import("../src/copilot/models");
  it('uses the default fallback when unset and none when CHAT_FALLBACK_MODEL=""', () => {
    expect(chatFallbacks(undefined, "@cf/a")).toEqual([DEFAULT_FALLBACK_MODEL]);
    expect(chatFallbacks("", "@cf/a")).toEqual([]);
    expect(chatFallbacks("  ", "@cf/a")).toEqual([]);
    expect(chatFallbacks("@cf/a", "@cf/a")).toEqual([]);
    expect(chatFallbacks("@cf/b", "@cf/a")).toEqual(["@cf/b"]);
  });
});

describe("tool JSON schemas", async () => {
  const { z } = await import("zod");
  const { createFireTools } = await import("../src/copilot/tools");
  const { createRealtimeTools } = await import("../src/copilot/realtime");
  const db = new DatabaseSync(":memory:");
  const sqlTag: SqlTag = (strings, ...values) => db.prepare(strings.join("?")).all(...(values as never[])) as never;
  const memory = new MemoryStore(sqlTag);
  memory.init();
  const tools = {
    ...createFireTools({ data: new MockFireData(), memory, getContext: () => null }),
    ...createRealtimeTools({ fetch: async () => new Response("{}") }, () => null)
  };

  // Workers AI validates tool parameters against JSON Schema 2020-12: array-form `items` (zod tuples) is rejected.
  it.each(Object.keys(tools))("%s has no tuple-style items", (name) => {
    const schema = z.toJSONSchema((tools as unknown as Record<string, { inputSchema: Parameters<typeof z.toJSONSchema>[0] }>)[name].inputSchema, { io: "input" });
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      const o = n as Record<string, unknown>;
      expect(Array.isArray(o.items), `${name}: array-form items`).toBe(false);
      expect("prefixItems" in o, `${name}: prefixItems`).toBe(false);
      Object.values(o).forEach(walk);
    };
    walk(schema);
  });
});

describe("get_app_help (site guide)", async () => {
  const { createFireTools } = await import("../src/copilot/tools");
  const { buildSystemPrompt } = await import("../src/copilot/prompt");
  const { GUIDE, GUIDE_TOPICS } = await import("@repo/app-guide");
  const db = new DatabaseSync(":memory:");
  const sqlTag: SqlTag = (strings, ...values) => db.prepare(strings.join("?")).all(...(values as never[])) as never;
  const memory = new MemoryStore(sqlTag);
  memory.init();
  const help = createFireTools({ data: new MockFireData(), memory, getContext: () => null }).get_app_help;
  const run = (topic: string) => (help.execute as unknown as (a: { topic: string }) => Promise<{ sections: { topic: string; text: string }[] }>)({ topic });

  it.each([...GUIDE_TOPICS])("returns the %s section from the guide", async (topic) => {
    const r = await run(topic);
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].text).toBe(GUIDE.find((s) => s.id === topic)!.body);
  });

  it("returns every section for 'all' and is not a data tool (no demo notice)", async () => {
    expect((await run("all")).sections.map((s) => s.topic)).toEqual([...GUIDE_TOPICS]);
    expect(JSON.stringify(await run("all"))).not.toMatch(/"dataSource"/);
  });

  it("the prompt routes questions about the site through it", () => {
    const p = buildSystemPrompt({ today: "2026-11-25", context: null, memories: [], webSearchEnabled: true, dataSource: "live" });
    expect(p).toMatch(/## Questions about this site[\s\S]*call get_app_help first/);
  });
});

describe("chat reasoning settings", async () => {
  const m = await import("../src/copilot/models");
  it("parses CHAT_REASONING_EFFORT and CHAT_CACHE_TTL", () => {
    expect(m.chatReasoningEffort(undefined)).toBeUndefined();
    expect(m.chatReasoningEffort("")).toBeUndefined();
    expect(m.chatReasoningEffort("none")).toBeNull();
    expect(m.chatReasoningEffort("off")).toBeNull();
    expect(m.chatReasoningEffort("high")).toBe("high");
    expect(m.effortLabel(null)).toBe("none");
    expect(m.chatCacheTtl("0")).toBeUndefined();
    expect(m.chatCacheTtl(undefined)).toBeUndefined();
    expect(m.chatCacheTtl("300")).toBe(300);
  });
});

describe("toUserError", async () => {
  const { toUserError } = await import("../src/copilot/errors");
  it("maps a deprecated/410 model error to a clear message", () => {
    const real = new Error("AiError: Model has been deprecated: @cf/moonshotai/kimi-k2.6 was deprecated on 2026-11-20. (a6e79bad-362c-45b6-ab2f-2d87cebdd11b)");
    expect(toUserError(real)).toMatch(/retired/);
    expect(toUserError(new Error('responseBody: {"internalCode":5028,"httpCode":410}'))).toMatch(/retired/);
    expect(toUserError("HTTP 410 Gone")).toMatch(/retired/);
  });
  it("maps the other known causes and falls back to the generic text", () => {
    expect(toUserError(new Error("Please configure AI Gateway in the dashboard"))).toMatch(/not set up/);
    expect(toUserError(new Error("daily free allocation of 10,000 neurons"))).toMatch(/quota/);
    expect(toUserError(new Error("Rate limit exceeded"))).toMatch(/rate-limited/);
    expect(toUserError(new Error("AI Gateway spend limit reached"))).toMatch(/spend limit/);
    expect(toUserError(new Error("boom"))).toMatch(/could not answer/);
  });
});

describe("regions and live data selection", async () => {
  const { classifyAgainst, regionLabel, regionOfBbox, regionOfPoint } = await import("../src/data/regionContext");
  const { createFireData } = await import("../src/data/fireData");
  const { LiveFireData } = await import("../src/data/liveFireData");

  it("FIRE_DATA_SOURCE=live selects LiveFireData; anything else the demo fixtures", () => {
    expect(createFireData({ FIRE_DATA_SOURCE: "live" } as Env)).toBeInstanceOf(LiveFireData);
    expect(createFireData({ FIRE_DATA_SOURCE: "mock" } as Env).source).toBe("mock");
    expect(createFireData({} as Env).source).toBe("mock");
  });

  it("maps points and boxes to the harmonized region, US territory only", () => {
    expect(regionOfPoint(-91.1, 30.0)?.id).toBe("southeast"); // Louisiana
    expect(regionOfPoint(-119.5, 37.0)?.id).toBe("california");
    expect(regionOfPoint(-155.3, 19.4)?.id).toBe("hawaii");
    expect(regionOfPoint(-107.0, 25.0)).toBeNull(); // Sinaloa, inside the southwest rectangle but not the US
    expect(regionOfPoint(-72.5, 47.0)).toBeNull(); // Quebec
    expect(regionOfBbox([-92, 29, -90, 31])?.id).toBe("southeast");
    expect(regionOfBbox([-110, 20, -105, 25])).toBeNull();
    expect(regionLabel(regionOfPoint(-91.1, 30.0)!)).toBe("Southeast region");
    expect(regionLabel(regionOfPoint(-119.5, 37.0)!)).toBe("California region");
  });

  it("outside coverage the live calendar says so and never returns demo numbers", async () => {
    const live = new LiveFireData({} as Env);
    const r = await live.getCalendar({ bbox: [-110, 20, -105, 25], from: "2020-01-01", to: "2020-12-31" });
    expect(r).toMatchObject({ dataSource: "live", available: false });
    expect((r as { message: string }).message).toMatch(/outside the harmonized archive/);
    expect(await live.getMonthToDate({ bbox: [-110, 20, -105, 25] })).toMatchObject({ available: false });
  });

  it("archival hotspots outside the near-real-time window are one honest sentence", async () => {
    const live = new LiveFireData({ D1_RETENTION_DAYS: "92" } as Env);
    const r = await live.getSpotsSummary({ mode: "archival", bbox: [-124.5, 32.5, -114, 42.1], from: "2020-08-01", to: "2020-08-31" });
    expect(r).toMatchObject({ dataSource: "live", available: false });
    const msg = (r as { message: string }).message;
    expect(msg).toMatch(/get_calendar/);
    expect(msg.split(/[.;]/).filter(Boolean)).toHaveLength(1);
  });

  it("classifies month-to-date against prorated percentiles", () => {
    const c = { median: 100, p10: 40, p25: 70, p75: 130, p90: 180 };
    expect(classifyAgainst(10, c, 0.5)).toBe("much_below"); // p10 × 0.5 = 20
    expect(classifyAgainst(50, c, 0.5)).toBe("normal");
    expect(classifyAgainst(100, c, 0.5)).toBe("much_above"); // p90 × 0.5 = 90
    expect(classifyAgainst(80, c, 0.5)).toBe("above");
  });
});

describe("D1 month-to-date and hotspot queries (sqlite stand-in for D1)", async () => {
  const { regionMonthToDate, regionOfPoint } = await import("../src/data/regionContext");
  const { LiveFireData } = await import("../src/data/liveFireData");

  const cellId = (lat: number, lon: number) => Math.floor((lat + 90) * 20) * 7200 + Math.floor((lon + 180) * 20);
  function fakeD1(db: DatabaseSync) {
    const prep = (sql: string) => {
      let params: unknown[] = [];
      const st = {
        bind(...p: unknown[]) { params = p; return st; },
        async all() { return { results: db.prepare(sql).all(...(params as never[])) }; }
      };
      return st;
    };
    return { prepare: prep, batch: async (sts: { all(): Promise<unknown> }[]) => Promise.all(sts.map((s) => s.all())) } as unknown as D1Database;
  }
  function seed() {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE nrt_availability (satellite TEXT, acq_date TEXT);
      CREATE TABLE nrt_cell_days (acq_date TEXT, cell_id INTEGER, satellite TEXT, sensor TEXT, grid_lat REAL, grid_lon REAL, peak_frp_mw REAL);
      CREATE TABLE nrt_detections (satellite TEXT, acq_date TEXT, acq_time INTEGER, lat REAL, lon REAL, sensor TEXT, confidence INTEGER, frp_mw REAL, cell_id INTEGER, heat_class TEXT);`);
    for (let d = 1; d <= 23; d++) {
      const date = `2026-11-${String(d).padStart(2, "0")}`;
      db.prepare("INSERT INTO nrt_availability VALUES ('SNPP', ?)").run(date);
      // Louisiana (southeast): 2 cells a day on SNPP, 1 on NOAA20 (not the reference, must not count)
      for (const [lat, lon] of [[30.01, -91.01], [30.06, -91.01]] as const)
        db.prepare("INSERT INTO nrt_cell_days VALUES (?, ?, 'SNPP', 'VIIRS', ?, ?, 20)").run(date, cellId(lat, lon), lat, lon);
      db.prepare("INSERT INTO nrt_cell_days VALUES (?, ?, 'NOAA20', 'VIIRS', 30.01, -91.01, 20)").run(date, cellId(30.01, -91.01));
      // Bahamas: inside the southeast rectangle, not US territory
      db.prepare("INSERT INTO nrt_cell_days VALUES (?, ?, 'SNPP', 'VIIRS', 25.26, -77.26, 20)").run(date, cellId(25.26, -77.26));
      // Texas Panhandle: great_plains, excluded from southeast and from its bbox
      db.prepare("INSERT INTO nrt_cell_days VALUES (?, ?, 'SNPP', 'VIIRS', 35.01, -101.01, 20)").run(date, cellId(35.01, -101.01));
    }
    return db;
  }

  it("counts the VIIRS reference satellite's cells of the region on US territory, through yesterday", async () => {
    const env = { NRT_DB: fakeD1(seed()) } as Env;
    const region = regionOfPoint(-91.1, 30.0)!;
    const r = await regionMonthToDate(env, region, new Date("2026-11-24T12:00:00Z"));
    expect(r).toMatchObject({ month: "2026-11", throughDay: 23, value: 46, daysWithoutViirs: [] });
    expect(r!.daily).toHaveLength(23);
    expect(r!.daily[0]).toEqual({ date: "2026-11-01", harmonizedCellDays: 2 });
  });

  it("an empty D1 tier is unavailable, not zero", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE nrt_availability (satellite TEXT, acq_date TEXT);
      CREATE TABLE nrt_cell_days (acq_date TEXT, cell_id INTEGER, satellite TEXT, sensor TEXT, grid_lat REAL, grid_lon REAL, peak_frp_mw REAL);`);
    const env = { NRT_DB: fakeD1(db), D1_RETENTION_DAYS: "92" } as Env;
    expect(await regionMonthToDate(env, regionOfPoint(-91.1, 30.0)!, new Date("2026-11-24T12:00:00Z"))).toBeNull();
  });

  it("realtime hotspot summary counts only fire-class detections in the box and says when the tier is empty", async () => {
    const db = seed();
    const today = new Date().toISOString().slice(0, 10);
    db.prepare("INSERT INTO nrt_availability VALUES ('SNPP', ?)").run(today);
    const ins = db.prepare("INSERT INTO nrt_detections VALUES ('SNPP', ?, ?, ?, ?, 'VIIRS', 80, ?, ?, ?)");
    ins.run(today, 130, 30.01, -91.01, 55.5, cellId(30.01, -91.01), "fire");
    ins.run(today, 1310, 30.06, -91.01, 12, cellId(30.06, -91.01), "fire");
    ins.run(today, 130, 30.01, -91.01, 999, cellId(30.01, -91.01), "industrial"); // excluded
    ins.run(today, 130, 40, -100, 5, cellId(40, -100), "fire"); // outside the box
    const live = new LiveFireData({ NRT_DB: fakeD1(db), D1_RETENTION_DAYS: "92" } as Env);
    const r = await live.getSpotsSummary({ mode: "realtime", bbox: [-92, 29, -90, 31], from: today, to: today });
    expect(r).toMatchObject({ dataSource: "live", counts: { detections: 2, distinctCells: 2, bySatellite: { SNPP: { detections: 2 } } }, lastSeen: `${today}T13:10:00Z` });
    expect((r as { topDetections: { frpMw: number }[] }).topDetections[0]!.frpMw).toBe(55.5);

    const empty = new DatabaseSync(":memory:");
    empty.exec(`CREATE TABLE nrt_availability (satellite TEXT, acq_date TEXT);`);
    const none = await new LiveFireData({ NRT_DB: fakeD1(empty), D1_RETENTION_DAYS: "92" } as Env).getSpotsSummary({ mode: "realtime", bbox: [-92, 29, -90, 31], from: today, to: today });
    expect(none).toMatchObject({ available: false });
    expect((none as { message: string }).message).toMatch(/get_live_incidents/);
  });
});

describe("answer post-processing of ids and punctuation", async () => {
  const { hideIncidentIds, fixStrayCommas } = await import("../src/copilot/postprocess");
  it("hides internal incident ids and collapses stray commas", () => {
    expect(hideIncidentIds("live.2278 and replay-ab12cd34.7 grew; version 1.5 stays")).toBe("this incident and this incident grew; version 1.5 stays");
    expect(fixStrayCommas("winds 12 km/h, , humidity 40%,, calm")).toBe("winds 12 km/h, humidity 40%, calm");
  });
});

describe("archival showcase responses", async () => {
  const { buildShowcaseResponse } = await import("../src/routes/showcase");
  const { SHOWCASE_PERIODS, overlapsPeriod } = await import("../src/data/showcase");
  const cellId = (lat: number, lon: number) => Math.floor((lat + 90) * 20) * 7200 + Math.floor((lon + 180) * 20);
  const ca = SHOWCASE_PERIODS[0]!;
  const A = cellId(38.51, -122.51), B = cellId(38.56, -122.51);
  const P = {
    ...ca,
    dates: ["2020-08-01", "2020-08-02"],
    // SNPP (2) weighs 1 on the VIIRS-reference rows; the Terra row (0) of the same cell-day weighs 0
    cells: { d: [0, 0, 1, 1], c: [A, A, A, B], s: [2, 0, 2, 2], p: [10, 50, 12, 7], n: [3, 2, 4, 1], w: [1, 0, 1, 1] },
    points: { lat: [38.51, 38.56, 38.51], lon: [-122.51, -122.51, -122.51], d: [0, 0, 1], t: [130, 1345, 200], f: [10, 99, 12], s: [2, 0, 2], q: [80, 100, 80], n: [1, 0, 1] }
  };
  const base = { level: "cells" as const, heat: "fire", sensor: "ALL" as const, measure: "harmonized", bbox: [-123, 38, -122, 39] as [number, number, number, number], from: "2020-08-01", to: "2020-08-02" };

  it("harmonized cells sum the calendar's weights, so totals match the rule (A: 2 days, B: 1)", () => {
    const r = buildShowcaseResponse(P, base) as any;
    const byId = Object.fromEntries(r.features.map((f: any) => [f.properties.cell_id, f.properties]));
    expect(byId[A]).toMatchObject({ harmonized_cell_days: 2, active_days: 2, last_seen: "2020-08-02" });
    expect(byId[B]).toMatchObject({ harmonized_cell_days: 1, active_days: 1 });
    expect(r.meta).toMatchObject({ harmonized: true, measure: "harmonized", showcase: { id: "california-2020-08" } });
    // the sum over cells equals the sum of weights in range
    expect(r.features.reduce((s: number, f: any) => s + f.properties.harmonized_cell_days, 0)).toBe(3);
  });

  it("clips the range to the period and respects the date window and bbox", () => {
    const r1 = buildShowcaseResponse(P, { ...base, from: "2020-08-02", to: "2020-08-02" }) as any;
    expect(r1.features).toHaveLength(2);
    const r2 = buildShowcaseResponse(P, { ...base, from: "2019-01-01", to: "2021-01-01" }) as any;
    expect(r2.meta).toMatchObject({ from: "2020-08-01", to: "2020-09-30" });
    expect(buildShowcaseResponse(P, { ...base, bbox: [-100, 30, -99, 31] }).features).toHaveLength(0);
  });

  it("raw cells and points filter by sensor; points are strongest first", () => {
    const modis = buildShowcaseResponse(P, { ...base, measure: "raw", sensor: "MODIS" }) as any;
    expect(modis.features).toHaveLength(1);
    expect(modis.features[0].properties).toMatchObject({ cell_days: 1, peak_frp_mw: 50 });
    const pts = buildShowcaseResponse(P, { ...base, level: "points", measure: "raw" }) as any;
    expect(pts.features.map((f: any) => f.properties.frp_mw)).toEqual([99, 12, 10]);
    expect(buildShowcaseResponse(P, { ...base, level: "points", measure: "raw", sensor: "VIIRS" }).features).toHaveLength(2);
  });

  it("Quebec is raw only, labelled as outside the harmonized archive; industrial heat is empty", () => {
    const q = SHOWCASE_PERIODS[1]!;
    expect(q.harmonized).toBe(false);
    expect(q.note).toBe("Raw VIIRS detections (outside the US harmonized archive)");
    const r = buildShowcaseResponse({ ...q, dates: ["2023-06-01"], cells: { d: [0], c: [cellId(50.5, -66)], s: [2], p: [20], n: [3], w: [0] }, points: { lat: [], lon: [], d: [], t: [], f: [], s: [], q: [], n: [] } },
      { ...base, bbox: [-67, 50, -65, 51], from: "2023-06-01", to: "2023-06-10" }) as any;
    expect(r.meta).toMatchObject({ harmonized: false, measure: "raw", note: q.note });
    expect(r.features[0].properties).toMatchObject({ cell_days: 1, peak_frp_mw: 20 });
    expect(buildShowcaseResponse(P, { ...base, heat: "industrial", level: "points" }).features).toEqual([]);
  });

  it("only dates and areas inside a showcase period overlap it", () => {
    expect(overlapsPeriod(ca, "2020-09-15", "2020-09-15", [-123, 38, -121, 40])).toBe(true);
    expect(overlapsPeriod(ca, "2021-01-01", "2021-01-31", [-123, 38, -121, 40])).toBe(false);
    expect(overlapsPeriod(ca, "2020-09-15", "2020-09-15", [-92, 29, -90, 31])).toBe(false); // Louisiana
  });
});
