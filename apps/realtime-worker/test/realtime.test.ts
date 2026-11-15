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
    expect(sum.areaKm2).toBeGreaterThan(20);
  });

  it("computes area, growth over the last 24 h of stream time, timeline and status", () => {
    const s = emptyState("x.1", "live");
    applyDetections(s, cellsIn(3, T0), T0);
    applyDetections(s, cellsIn(6, T0 + 30 * H).slice(3), T0 + 30 * H);
    const sum = summarize(s);
    const cellArea = sum.areaKm2 / 6;
    expect(sum.growthKm2PerDay).toBeCloseTo(cellArea * 3, 0);
    expect(growthKm2PerDay(s, T0 + 10 * H)).toBeCloseTo(cellArea * 3, 0);
    const tl = timeline(s);
    expect(tl).toHaveLength(2);
    expect(tl[1].areaKm2).toBeCloseTo(sum.areaKm2, 0);
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
