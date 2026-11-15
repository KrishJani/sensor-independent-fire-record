import { describe, expect, it } from "vitest";
import { coverage, inUS } from "./coverage.ts";

describe("harmonized coverage", () => {
  it("NorCal and the California region are covered", () => {
    expect(coverage([-124, 36, -119, 42])).toBe(1);
    expect(coverage([-124.5, 32.5, -114, 42.1])).toBeGreaterThan(0.9);
  });
  it("Quebec views are outside (< 0.5)", () => {
    expect(coverage([-80, 45, -60, 53])).toBeLessThan(0.5); // Quebec replay area
    expect(coverage([-78, 47, -72, 50])).toBe(0); // south Quebec: inside midwest_northeast's rectangle
    expect(coverage([-78, 50, -72, 53])).toBe(0); // north Quebec
  });
  it("borders", () => {
    expect(inUS(-69, 47)).toBe(true); // northern Maine
    expect(inUS(-73.6, 45.5)).toBe(false); // Montreal
    expect(inUS(-123.1, 49.3)).toBe(false); // Vancouver
    expect(inUS(-122.3, 47.6)).toBe(true); // Seattle
    expect(inUS(-106.4, 31.7)).toBe(false); // Ciudad Juarez
    expect(inUS(-149.9, 61.2)).toBe(true); // Anchorage
    expect(inUS(-135, 61)).toBe(false); // Yukon
    expect(inUS(-83.2, 42.4)).toBe(true); // Detroit (west of the river)
    expect(inUS(-79.4, 43.7)).toBe(false); // Toronto
  });
});
