import { describe, expect, it } from "vitest";
import { assignDetections, LINK_WINDOW_MS, MemoryClusterStore } from "../src/cluster";
import {
  detectionId,
  detectionTime,
  fromCompact,
  normalizeConfidence,
  normalizeCsv,
  normalizeRow,
  normalizeSatellite,
  toCompact,
  withStream,
  type Detection,
  type RawDetection
} from "../src/detection";
import { cellAreaKm2, cellKey, cellOf, neighborCells, parseBbox } from "../src/grid";
import {
  applyDetections,
  emptyState,
  enrichmentDue,
  growthKm2PerDay,
  statusAt,
  summarize,
  timeline
} from "../src/incidentModel";
import { incidentId, isStream, streamOfIncident } from "../src/streams";

const H = 3600_000;
const T0 = Date.UTC(2023, 5, 1, 0, 0);

function det(lat: number, lon: number, t: number, extra: Partial<RawDetection> = {}): Detection {
  return withStream(
    { lat, lon, t, sensor: "VIIRS", satellite: "SNPP", frp: 10, confidence: "nominal", daynight: "D", ...extra },
    "replay:test01"
  );
}

describe("normalization", () => {
  it("parses VIIRS SP rows, keeps type 0 only", () => {
    const csv = [
      "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type",
      "48.1,-75.2,330,0.4,0.4,2023-06-02,535,N,VIIRS,h,2,290,12.5,N,0",
      "48.1,-75.3,330,0.4,0.4,2023-06-02,1805,1,VIIRS,l,2,290,1.5,D,0",
      "48.1,-75.4,330,0.4,0.4,2023-06-02,1805,N,VIIRS,n,2,290,1.5,D,2"
    ].join("\n");
    const { detections, nonVegetation } = normalizeCsv(csv, "VIIRS_SNPP_SP");
    expect(nonVegetation).toBe(1);
    expect(detections).toHaveLength(2);
    expect(detections[0]).toMatchObject({
      lat: 48.1,
      lon: -75.2,
      t: Date.UTC(2023, 5, 2, 5, 35),
      sensor: "VIIRS",
      satellite: "SNPP",
      frp: 12.5,
      confidence: "high",
      daynight: "N"
    });
    expect(detections[1]).toMatchObject({ satellite: "NOAA20", confidence: "low", daynight: "D" });
  });

  it("parses MODIS NRT rows (no type column)", () => {
    const r = normalizeRow({
      latitude: "37.291",
      longitude: "-119.43645",
      acq_date: "2026-11-13",
      acq_time: "0353",
      satellite: "Terra",
      instrument: "MODIS",
      confidence: "66",
      frp: "15",
      daynight: "N"
    });
    expect(r.detection).toMatchObject({ sensor: "MODIS", satellite: "TERRA", confidence: "nominal", t: Date.UTC(2026, 10, 13, 3, 53) });
  });

  it("maps MODIS confidence 0-29 low, 30-79 nominal, 80-100 high", () => {
    expect(normalizeConfidence("0", "MODIS")).toBe("low");
    expect(normalizeConfidence("29", "MODIS")).toBe("low");
    expect(normalizeConfidence("30", "MODIS")).toBe("nominal");
    expect(normalizeConfidence("79", "MODIS")).toBe("nominal");
    expect(normalizeConfidence("80", "MODIS")).toBe("high");
    expect(normalizeConfidence("100", "MODIS")).toBe("high");
    expect(normalizeConfidence("n", "VIIRS")).toBe("nominal");
    expect(normalizeConfidence("x", "VIIRS")).toBeNull();
  });

  it("normalizes satellite codes", () => {
    expect(normalizeSatellite("Aqua")).toBe("AQUA");
    expect(normalizeSatellite("N")).toBe("SNPP");
    expect(normalizeSatellite("1")).toBe("NOAA20");
    expect(normalizeSatellite("N21")).toBe("NOAA21");
    expect(normalizeSatellite("?")).toBeNull();
  });

  it("builds detection time from acq_date + acq_time (UTC, short times padded)", () => {
    expect(detectionTime("2020-08-15", "535")).toBe(Date.UTC(2020, 7, 15, 5, 35));
    expect(detectionTime("2020-08-15", "5")).toBe(Date.UTC(2020, 7, 15, 0, 5));
  });

  it("id is a stable hash of satellite+lat+lon+t", () => {
    const a = { satellite: "SNPP" as const, lat: 1.5, lon: 2.5, t: 1000 };
    expect(detectionId(a)).toBe(detectionId({ ...a }));
    expect(detectionId(a)).not.toBe(detectionId({ ...a, satellite: "NOAA20" }));
    expect(detectionId(a)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("compact encoding round-trips", () => {
    const d: RawDetection = { lat: 48.12345, lon: -75.5, t: T0, sensor: "MODIS", satellite: "AQUA", frp: 33.3, confidence: "high", daynight: "D" };
    expect(fromCompact(toCompact(d))).toEqual(d);
  });
});

describe("grid", () => {
  it("assigns 0.05° cells, including exact grid lines", () => {
    expect(cellOf(0, 0)).toEqual({ row: 1800, col: 3600 });
    expect(cellOf(45.05, -75.05)).toEqual(cellOf(45.0500001, -75.0499999));
    expect(cellOf(45.049, -75.0)).not.toEqual(cellOf(45.05, -75.0));
  });

  it("has 9 neighbours including itself", () => {
    const n = neighborCells({ row: 10, col: 10 }).map(cellKey);
    expect(n).toHaveLength(9);
    expect(new Set(n).size).toBe(9);
    expect(n).toContain("10:10");
    expect(n).toContain("9:11");
  });

  it("cell area shrinks with cos(lat)", () => {
    const eq = cellAreaKm2(cellOf(0, 0));
    expect(eq).toBeCloseTo((0.05 * 111.32) ** 2, 1);
    const at60 = cellAreaKm2(cellOf(60, 0));
    expect(at60 / eq).toBeCloseTo(0.5, 2);
  });

  it("parses bboxes", () => {
    expect(parseBbox("-80,45,-60,53")).toEqual([-80, 45, -60, 53]);
    expect(parseBbox("-60,45,-80,53")).toBeNull();
    expect(parseBbox("a,b")).toBeNull();
  });
});

describe("clustering", () => {
  it("dedupes by id", () => {
    const store = new MemoryClusterStore();
    const d = det(48, -75, T0);
    const r1 = assignDetections(store, [d, d]);
    expect(r1.duplicates).toBe(1);
    const r2 = assignDetections(store, [d]);
    expect(r2.duplicates).toBe(1);
    expect(r2.fresh).toHaveLength(0);
  });

  it("links detections in neighbouring cells, creates new incidents further away", () => {
    const store = new MemoryClusterStore();
    const r = assignDetections(store, [
      det(48.0, -75.0, T0),
      det(48.06, -75.04, T0 + H), // next cell north
      det(48.5, -75.0, T0 + H) // far away
    ]);
    expect(r.created).toHaveLength(2);
    expect([...r.byIncident.values()].map((v) => v.length).sort()).toEqual([1, 2]);
  });

  it("low-confidence detections are counted but never create or grow incidents", () => {
    const store = new MemoryClusterStore();
    const r = assignDetections(store, [det(48, -75, T0, { confidence: "low" })]);
    expect(r.lowConfidence).toBe(1);
    expect(r.created).toHaveLength(0);
    expect(r.fresh).toHaveLength(1);
    assignDetections(store, [det(48, -75, T0 + H)]);
    const again = assignDetections(store, [det(48.01, -75.01, T0 + 2 * H, { confidence: "low" })]);
    expect(again.byIncident.size).toBe(0);
  });

  it("uses a 48 h window of stream time (detection time), not wall clock", () => {
    const store = new MemoryClusterStore();
    const first = assignDetections(store, [det(48, -75, T0)]);
    const id = first.created[0];
    // 47 h later in stream time: links.
    const near = assignDetections(store, [det(48.01, -75.01, T0 + 47 * H)]);
    expect([...near.byIncident.keys()]).toEqual([id]);
    // 48 h + 1 min after the incident's last detection (T0 + 47 h): a new incident.
    const later = T0 + 47 * H + LINK_WINDOW_MS + 60_000;
    const far = assignDetections(store, [det(48.0, -75.0, later)]);
    expect(far.created).toHaveLength(1);
    expect(far.created[0]).not.toBe(id);
    // and the cell now belongs to the new incident
    const next = assignDetections(store, [det(48.0, -75.0, later + H)]);
    expect([...next.byIncident.keys()]).toEqual([far.created[0]]);
  });

  it("is independent of batch order (time sorted inside the batch)", () => {
    const a = new MemoryClusterStore();
    const b = new MemoryClusterStore();
    const ds = [det(48, -75, T0 + 60 * H), det(48.01, -75.01, T0)];
    assignDetections(a, ds);
    assignDetections(b, [...ds].reverse());
    expect([...a.incidents.values()].map((i) => i.firstT)).toEqual([...b.incidents.values()].map((i) => i.firstT));
    expect(a.incidents.size).toBe(2); // 60 h apart: two incidents
  });

  it("when a detection touches two incidents, keeps the older and records the merge", () => {
    const store = new MemoryClusterStore();
    const r1 = assignDetections(store, [det(48.0, -75.0, T0), det(48.0, -74.9, T0 + H)]);
    expect(r1.created).toHaveLength(2);
    const [older, newer] = r1.created;
    // A detection between them (cell adjacent to both).
    const bridge = assignDetections(store, [det(48.0, -74.95, T0 + 2 * H)]);
    expect([...bridge.byIncident.keys()]).toEqual([older]);
    expect(bridge.merges).toEqual([{ from: newer, into: older, t: T0 + 2 * H }]);
    expect(store.incidents.get(newer)!.mergedInto).toBe(older);
    // Later detections next to the absorbed incident go to the survivor.
    const after = assignDetections(store, [det(48.0, -74.89, T0 + 3 * H)]);
    expect([...after.byIncident.keys()]).toEqual([older]);
  });
});

describe("incident aggregate", () => {
  const cellsIn = (n: number, t: number) => Array.from({ length: n }, (_, i) => det(48 + i * 0.05, -75, t + i * 60_000));

  it("becomes significant at >= 5 detections across >= 2 cells", () => {
    const s = emptyState("replay-test01.1", "replay:test01");
    applyDetections(s, [0, 1, 2, 3, 4].map((i) => det(48.01 + i * 0.001, -75.02 + i * 0.001, T0 + i)), T0);
    expect(summarize(s).significant).toBe(false); // 5 detections, 1 cell
    applyDetections(s, [det(48.06, -75.02, T0 + H)], T0 + H);
    const sum = summarize(s);
    expect(sum.significant).toBe(true);
    expect(sum.cells).toBe(2);
    expect(sum.detections).toBe(6);
    expect(sum.affectedAreaKm2).toBeGreaterThan(20);
  });

  it("computes area, growth over the last 24 h of stream time, timeline and status", () => {
    const s = emptyState("x.1", "live");
    applyDetections(s, cellsIn(3, T0), T0);
    applyDetections(s, cellsIn(6, T0 + 30 * H).slice(3), T0 + 30 * H);
    const sum = summarize(s);
    const cellArea = sum.affectedAreaKm2 / 6;
    expect(sum.growthKm2PerDay).toBeCloseTo(cellArea * 3, 0);
    expect(growthKm2PerDay(s, T0 + 10 * H)).toBeCloseTo(cellArea * 3, 0);
    const tl = timeline(s);
    expect(tl).toHaveLength(2);
    expect(tl[1].affectedAreaKm2).toBeCloseTo(sum.affectedAreaKm2, 0);
    expect(statusAt(s, T0 + 30 * H + 47 * H)).toBe("active");
    expect(statusAt(s, T0 + 30 * H + 49 * H)).toBe("inactive");
  });

  it("enrichment is due on first significance, then on area doubling at most every 6 h of stream time", () => {
    const s = emptyState("x.1", "live");
    applyDetections(s, cellsIn(5, T0), T0);
    const first = enrichmentDue(s, T0);
    expect(first?.reason).toBe("significant");
    s.enrichments.push(first!);
    expect(enrichmentDue(s, T0 + H)).toBeNull();
    applyDetections(s, cellsIn(11, T0 + 2 * H).slice(5), T0 + 2 * H); // area doubled, but < 6 h
    expect(enrichmentDue(s, T0 + 2 * H)).toBeNull();
    expect(enrichmentDue(s, T0 + 6 * H)?.reason).toBe("area_doubled");
  });

  it("remembers the first detection id as a stable key across replays", () => {
    const a = emptyState("replay-aaaaaa.3", "replay:aaaaaa");
    const b = emptyState("replay-bbbbbb.3", "replay:bbbbbb");
    applyDetections(a, cellsIn(3, T0), T0);
    applyDetections(b, cellsIn(3, T0).map((d) => withStream(d, "replay:bbbbbb")), T0);
    applyDetections(a, cellsIn(5, T0 + H).slice(3), T0 + H);
    expect(a.firstDetectionId).toBeTruthy();
    expect(a.firstDetectionId).toBe(b.firstDetectionId);
  });

  it("with a minimum area, the first enrichment waits until the affected area reaches it", () => {
    const s = emptyState("x.1", "replay:test01");
    applyDetections(s, cellsIn(5, T0), T0);
    const area = summarize(s).affectedAreaKm2;
    expect(enrichmentDue(s, T0, area + 1)).toBeNull();
    applyDetections(s, cellsIn(6, T0 + H).slice(5), T0 + H);
    expect(enrichmentDue(s, T0 + H, area + 1)?.reason).toBe("significant");
  });
});

describe("enrichment config", async () => {
  const { briefMinAreaKm2 } = await import("../src/streams");
  const { briefModels, reasoningParams } = await import("../src/enrich/brief");

  it("min brief area applies to replays only", () => {
    expect(briefMinAreaKm2({ BRIEF_MIN_AREA_KM2: "200" }, "live")).toBe(0);
    expect(briefMinAreaKm2({ BRIEF_MIN_AREA_KM2: "200" }, "replay:abcdef12")).toBe(200);
    expect(briefMinAreaKm2({ BRIEF_MIN_AREA_KM2: "x" } as never, "replay:abcdef12")).toBe(200);
  });

  it("brief cache key: scenario + stable incident key + doubling level", async () => {
    const { briefCacheKey } = await import("../src/enrich/brief");
    expect(briefCacheKey("quebec-2023-06", "abc123", 0)).toBe("brief-cache/v6/quebec-2023-06/abc123/0");
  });

  it("CHAT_FALLBACK_MODEL='' disables the fallback; reasoning effort only for kimi", () => {
    expect(briefModels({ CHAT_MODEL: "@cf/a", CHAT_FALLBACK_MODEL: "@cf/b" })).toEqual(["@cf/a", "@cf/b"]);
    expect(briefModels({ CHAT_MODEL: "@cf/a", CHAT_FALLBACK_MODEL: "" })).toEqual(["@cf/a"]);
    expect(reasoningParams({ BRIEF_REASONING_EFFORT: "none" }, "@cf/moonshotai/kimi-k2.6")).toEqual({ reasoning_effort: "none" });
    expect(reasoningParams({ BRIEF_REASONING_EFFORT: "none" }, "@cf/zai-org/glm-4.7-flash")).toEqual({});
    expect(reasoningParams({ BRIEF_REASONING_EFFORT: "" }, "@cf/moonshotai/kimi-k2.6")).toEqual({});
  });
});

describe("streams", () => {
  it("validates streams and maps incident ids back to streams", () => {
    expect(isStream("live")).toBe(true);
    expect(isStream("replay:ab12cd34ef")).toBe(true);
    expect(isStream("replay:")).toBe(false);
    expect(streamOfIncident(incidentId("live", 4))).toBe("live");
    expect(streamOfIncident(incidentId("replay:ab12cd34ef", 12))).toBe("replay:ab12cd34ef");
    expect(streamOfIncident("nope")).toBeNull();
  });
});

describe("brief", async () => {
  const { buildBriefPrompt, cleanBrief } = await import("../src/enrich/brief");
  const { extractText } = await import("../src/enrich/workflow").catch(() => ({ extractText: null }));

  it("cleans model output: no em dashes, no advice, max 3 sentences", () => {
    const out = cleanBrief(
      "<think>hmm</think>**Fire** grew to 120.5 km2 — fast. Winds are 20 km/h. Residents should evacuate now. Humidity is 30%. Extra sentence."
    );
    expect(out).toBe("Fire grew to 120.5 km2, fast. Winds are 20 km/h. Humidity is 30%.");
    expect(out).not.toMatch(/[—–]/);
  });

  it("drops a sentence cut off by max_tokens", () => {
    expect(cleanBrief("Area is 10 km2. Wind is 5 km/h. The nearest town is Ch")).toBe("Area is 10 km2. Wind is 5 km/h.");
  });

  it("never says burned area", () => {
    expect(cleanBrief("The burned area is 120 km2.")).toBe("The area with detections is 120 km2.");
  });

  it("prompt contains only the given numbers and skips mock history", () => {
    const s = emptyState("live.1", "live");
    applyDetections(s, [0, 1, 2, 3, 4, 5].map((i) => det(48 + i * 0.05, -75, T0 + i * H)), T0 + 5 * H);
    const msgs = buildBriefPrompt({
      summary: summarize(s),
      stream: "live",
      weather: { status: "ok", data: { windSpeedKmh: 22, windFrom: "SW", relativeHumidityPct: 31, temperatureC: 24 } },
      places: { status: "ok", data: [{ name: "Chibougamau", distanceKm: 12.3, direction: "NE" }] },
      history: { status: "ok", data: { dataSource: "mock", summary: { peak: 999 } } }
    });
    const user = msgs[1].content;
    expect(user).toContain("22 km/h from the SW");
    expect(user).toContain("Chibougamau (12.3 km NE)");
    expect(user).toContain("Nearest populated places");
    expect(user).not.toContain("999");
    expect(msgs[0].content).toMatch(/Never give evacuation/);
    expect(user).toContain("Area with detections:");
    expect(user).not.toMatch(/burned area/i);
    expect(msgs[0].content).toContain('"area with detections"');
  });
  void extractText;
});

describe("allowed origins", async () => {
  const { isAllowedOrigin, parseAllowedOrigins } = await import("../src/origins");
  const allowed = parseAllowedOrigins("http://localhost:5173, https://nasa-fire-web.pages.dev,https://*.nasa-fire-web.pages.dev");
  it("allows exact origins and one-label Pages preview subdomains only", () => {
    expect(isAllowedOrigin("http://localhost:5173", allowed)).toBe(true);
    expect(isAllowedOrigin("https://nasa-fire-web.pages.dev", allowed)).toBe(true);
    expect(isAllowedOrigin("https://a1b2c3d4.nasa-fire-web.pages.dev", allowed)).toBe(true);
    expect(isAllowedOrigin("https://feat-realtime.nasa-fire-web.pages.dev", allowed)).toBe(true);
  });
  it("rejects everything else", () => {
    for (const o of [
      "http://a1b2.nasa-fire-web.pages.dev",
      "https://a.b.nasa-fire-web.pages.dev",
      "https://evilnasa-fire-web.pages.dev",
      "https://nasa-fire-web.pages.dev.evil.com",
      "https://x.nasa-fire-web.pages.dev:8443",
      "https://-x.nasa-fire-web.pages.dev",
      "http://localhost:5174",
      "null",
      ""
    ])
      expect(isAllowedOrigin(o, allowed), o).toBe(false);
    expect(isAllowedOrigin("https://anything.com", parseAllowedOrigins("*"))).toBe(false);
  });
});

describe("places", async () => {
  const { finalizePlaces, parseOverpass, parsePhoton, fetchPlaces } = await import("../src/enrich/places");
  const lat = 48.9184, lon = -76.4023;

  it("parses Photon place features, drops houses, dedupes names, keeps 75 km", () => {
    const f = (name: string | undefined, value: string, c: [number, number], key = "place") => ({ geometry: { coordinates: c }, properties: { osm_key: key, osm_value: value, name } });
    const out = finalizePlaces(
      parsePhoton(
        [
          f("Quévillon", "locality", [-76.9395, 49.0084]),
          f("Quévillon", "locality", [-76.9395, 49.0084]),
          f(undefined, "house", [-76.96, 49.03], "building"),
          f("Lebel-sur-Quévillon", "village", [-76.9805, 49.0534]),
          f("Far", "town", [-70, 49])
        ],
        lat,
        lon
      )
    );
    // Within 5 km of each other, the village outranks the locality.
    expect(out.map((p) => p.name)).toEqual(["Lebel-sur-Quévillon", "Quévillon"]);
    expect(out[0]).toMatchObject({ place: "village", direction: expect.any(String) });
  });

  it("parses Overpass elements", () => {
    const out = parseOverpass([{ lat: 49.05, lon: -76.98, tags: { name: "Lebel-sur-Quévillon", place: "village", population: "2,091" } }], lat, lon);
    expect(out[0]).toMatchObject({ name: "Lebel-sur-Quévillon", place: "village", population: 2091 });
  });

  it("falls back to Photon when Overpass fails, and throws with every reason when all fail", async () => {
    const calls: string[] = [];
    const ok = await fetchPlaces(async (url) => {
      calls.push(new URL(url).host);
      if (url.includes("overpass")) throw new Error("timeout");
      return { features: [] };
    }, lat, lon);
    expect(ok).toEqual({ places: [], source: "photon" });
    expect(calls).toEqual(["overpass-api.de", "overpass.kumi.systems", "photon.komoot.io"]);
    await expect(fetchPlaces(async () => { throw new Error("down"); }, lat, lon)).rejects.toThrow(/overpass-api.de: down.*photon.komoot.io: down/);
  });
});

import { historyBbox, summarizeCalendar, type CalendarResponse } from "../src/enrich/history";

describe("historical context (api-worker /api/calendar)", () => {
  const res: CalendarResponse = {
    range: { from: "2005-01-01", to: "2019-12-31" },
    units: "cell-days",
    annual: [{ year: 2017, harmonizedCellDays: 120 }, { year: 2018, harmonizedCellDays: 40 }],
    climatology: [{ month: 8, median: 4, p75: 7, p90: 12.2, n: 15 }],
    summary: { peakMonth: "2017-10", peakYear: 2017, criticalMonthNames: ["Aug", "Oct"] }
  };
  it("summarizes the calendar for the incident month", () => {
    expect(summarizeCalendar(res, 8)).toBe("2005-2019 harmonized archive; typical Aug 4 active cell-days (p90 12.2, 15 years); fire season Aug/Oct; busiest year 2017");
  });
  it("returns null when the archive has no activity", () => {
    expect(summarizeCalendar({ ...res, annual: [{ year: 2017, harmonizedCellDays: 0 }] }, 8)).toBeNull();
  });
  it("pads a small bbox to at least 0.5 degrees a side", () => {
    expect(historyBbox([-122, 39, -121.9, 39.1])).toEqual([-122.2, 38.8, -121.7, 39.3]);
  });
});

import { cleanBrief as clean } from "../src/enrich/brief";
describe("cleanBrief: remarks about missing facts", () => {
  it("drops 'No historical context was provided' and keeps the rest", () => {
    expect(clean("The area with detections is 354.7 km2. Wind is 10.3 km/h from the north. No historical context was provided for typical June fire activity or fire season months."))
      .toBe("The area with detections is 354.7 km2. Wind is 10.3 km/h from the north.");
  });
});

import { briefCacheFull, cooldownLeftMs, incidentsToPrune, pickCachedLevel, REPLAY_START_COOLDOWN_MS } from "../src/limits";
import { briefCacheKey, briefCachePrefix } from "../src/enrich/brief";
describe("demo limits", () => {
  it("replay start cooldown", () => {
    expect(cooldownLeftMs(null, 1_000)).toBe(0);
    expect(cooldownLeftMs(1_000, 1_000 + REPLAY_START_COOLDOWN_MS - 1)).toBe(1);
    expect(cooldownLeftMs(1_000, 1_000 + REPLAY_START_COOLDOWN_MS)).toBe(0);
  });
  it("reuses another cached level of the same incident", () => {
    expect(pickCachedLevel([], 0)).toBeNull();
    expect(pickCachedLevel([0], 2)).toBe(0);
    expect(pickCachedLevel([0, 1, 3], 2)).toBe(1);
    expect(pickCachedLevel([2, 3], 1)).toBe(2);
    expect(pickCachedLevel([Number.NaN, 1], 0)).toBe(1);
  });
  it("brief cache is full at ENRICH_MAX_PER_STREAM", () => {
    expect(briefCacheFull(9, 10)).toBe(false);
    expect(briefCacheFull(10, 10)).toBe(true);
  });
  it("cache key starts with the incident prefix, which starts with the scenario prefix", () => {
    const key = briefCacheKey("quebec-2023-06", "abc", 2);
    expect(key.startsWith(briefCachePrefix("quebec-2023-06", "abc"))).toBe(true);
    expect(briefCachePrefix("quebec-2023-06", "abc").startsWith(briefCachePrefix("quebec-2023-06"))).toBe(true);
    expect(Number(key.split("/").pop())).toBe(2);
  });
  it("prunes quiet incidents with their merge chains, keeps those merged into active ones", () => {
    const cutoff = 100;
    const rows = [
      { id: "a", last_t: 50, merged_into: null }, // quiet survivor
      { id: "b", last_t: 40, merged_into: "a" }, // merged into a
      { id: "c", last_t: 30, merged_into: "b" }, // chain through b
      { id: "d", last_t: 200, merged_into: null }, // active
      { id: "e", last_t: 20, merged_into: "d" } // old, but merged into an active incident
    ];
    expect([...incidentsToPrune(rows, cutoff)].sort()).toEqual(["a", "b", "c"]);
  });
});
