import { z } from "zod";

/** What the web app sends as `body.context` with every chat message (SPEC §4.1). */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const BboxSchema = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90)
  ])
  .refine(([w, s, e, n]) => w < e && s < n, "bbox must be [west, south, east, north]");

export type Bbox = z.infer<typeof BboxSchema>;

export const AoiSchema = z.object({
  bbox: BboxSchema,
  label: z.string().max(200).optional(),
  // GeoJSON Polygon/MultiPolygon. Only the bbox is used for queries by the mock;
  // LiveFireData can use it for pointInPolygon. Kept loose on purpose.
  geometry: z
    .object({ type: z.enum(["Polygon", "MultiPolygon"]), coordinates: z.array(z.any()) })
    .optional()
});

export type Aoi = z.infer<typeof AoiSchema>;

export const MapContextSchema = z.object({
  tab: z.enum(["archival", "realtime"]),
  aoi: AoiSchema.nullable(),
  from: isoDate,
  to: isoDate,
  // Free-form summary of what the calendar drawer is showing. Truncated before use.
  calendarSummary: z.unknown().optional(),
  // Realtime pipeline stream the map is showing: "live" or "replay:<id>" (apps/realtime-worker).
  realtimeStream: z
    .string()
    .regex(/^(live|replay:[a-z0-9]{6,32})$/)
    .optional()
});

export type MapContext = z.infer<typeof MapContextSchema>;

/**
 * Parse `body.context`. Invalid or missing context is never fatal: we log and
 * return null so the turn falls back to the previously stored context.
 */
export function parseContext(raw: unknown): MapContext | null {
  if (raw === undefined || raw === null) return null;
  const parsed = MapContextSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn("[copilot] ignoring invalid context:", z.prettifyError(parsed.error));
    return null;
  }
  return parsed.data;
}

/** Compact text form for the system prompt. */
export function describeContext(ctx: MapContext | null): string {
  if (!ctx) return "No map context received yet (the user has not selected an area or range).";
  const lines = [
    `Tab: ${ctx.tab}`,
    `Date range: ${ctx.from} to ${ctx.to}`,
    ctx.aoi
      ? `Area of interest: ${ctx.aoi.label ?? "unnamed area"} bbox [${ctx.aoi.bbox.join(", ")}]` +
        (ctx.aoi.geometry ? ` (${ctx.aoi.geometry.type} drawn)` : "")
      : "Area of interest: none selected"
  ];
  if (ctx.realtimeStream) {
    lines.push(
      `Realtime stream on the map: ${ctx.realtimeStream}` +
        (ctx.realtimeStream === "live" ? "" : " (a replay of a stored historical scenario, not current activity)")
    );
  }
  if (ctx.calendarSummary !== undefined) {
    const s = JSON.stringify(ctx.calendarSummary);
    lines.push(`Calendar summary shown to the user: ${s.length > 1500 ? s.slice(0, 1500) + "…" : s}`);
  }
  return lines.join("\n");
}
