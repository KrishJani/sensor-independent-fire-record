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
