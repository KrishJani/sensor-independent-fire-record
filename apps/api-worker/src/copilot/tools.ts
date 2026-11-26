import { tool } from "ai";
import { z } from "zod";
import { GUIDE, GUIDE_TOPICS, guideSection } from "@repo/app-guide";
import type { FireData } from "../data/fireData";
import { BboxSchema, type Bbox, type MapContext } from "./context";
import { MEMORY_KINDS, type MemoryStore } from "./memory";

/**
 * Grounding tools (SPEC §4.5). Every argument is optional and falls back to the
 * map context the web app last sent, so "and last year?" just works.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD (UTC)");
const bboxArg = BboxSchema.optional().describe(
  "[west, south, east, north] in WGS84 degrees. Omit to use the area selected on the map."
);

const NO_AREA = {
  error: "no_area",
  message:
    "No area of interest: the user has not selected one on the map and no bbox was given. Ask the user to draw or select an area, or pass a bbox."
} as const;

export interface ToolDeps {
  data: FireData;
  memory: MemoryStore;
  getContext: () => MapContext | null;
}

function resolveBbox(arg: Bbox | undefined, ctx: MapContext | null): Bbox | null {
  return arg ?? ctx?.aoi?.bbox ?? null;
}

const withErrors =
  <A, R>(fn: (args: A) => Promise<R> | R) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      console.error("[copilot] tool failed:", err);
      return { error: "tool_failed", message: err instanceof Error ? err.message : String(err) };
    }
  };

/** Same or overlapping bboxes (touching edges do not count). */
export const bboxesOverlap = (a: Bbox, b: Bbox) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

const isOutside = (r: unknown) => !!r && typeof r === "object" && (r as { reason?: string }).reason === "outside_coverage";

export function createFireTools({ data, memory, getContext }: ToolDeps) {
  // Once the calendar says an area is outside the archive, later calls in the same request for that area (same or
  // overlapping bbox) get the same answer, so a retry with a nudged bbox cannot pull in a neighbouring region's
  // calendar. Calls for a separate area (e.g. California after Quebec) are answered normally.
  const outsideAreas: { bbox: Bbox; result: unknown }[] = [];
  return {
    get_calendar: tool({
      description:
        "Harmonized MODIS+VIIRS burning-activity calendar (archival) for the US region containing an area (US only: outside it there is no calendar, and never substitute another region) (region-level; the result names the region): peak month/year, critical fire-season months, climatology (median, P10–P90 per calendar month), annual totals and the most anomalous months. Unit: active cell-days. Use for history, seasonality, trends and 'is this normal / how unusual' questions. For 'what happened here in <month>' call get_spots_summary first (calling both is fine).",
      inputSchema: z.object({
        bbox: bboxArg,
        from: date.optional().describe("Start date. Omit to use the map's range."),
        to: date.optional().describe("End date. Omit to use the map's range."),
        months: z
          .array(z.number().int().min(1).max(12))
          .optional()
          .describe("Only these calendar months, e.g. [8] for Augusts only.")
      }),
      execute: withErrors(async (args: { bbox?: Bbox; from?: string; to?: string; months?: number[] }) => {
        const ctx = getContext();
        const bbox = resolveBbox(args.bbox, ctx);
        if (!bbox) return NO_AREA;
        const known = outsideAreas.find((o) => bboxesOverlap(o.bbox, bbox));
        if (known) return known.result;
        const r = await data.getCalendar({
          bbox,
          from: args.from ?? ctx?.from ?? "2000-11-01",
          to: args.to ?? ctx?.to ?? new Date().toISOString().slice(0, 10),
          months: args.months ?? null
        });
        if (isOutside(r)) outsideAreas.push({ bbox, result: r });
        return r;
      })
    }),

    get_spots_summary: tool({
      description:
        "Call this FIRST for 'what is burning now / this week' (mode realtime, last ~90 days). For the past it covers the Archival showcase periods (California Aug–Sep 2020, harmonized; Quebec 1–10 June 2023, raw VIIRS), the same data the map draws; other past hotspot detail is not loaded: if it says so, use get_calendar. Returns hotspot detections in an area and date range: detection counts, active cell-days per satellite, daily activity, last-seen time and the top detections by fire radiative power (FRP, MW, labelled by sensor). mode 'archival' = finalized FIRMS SP data (past), 'realtime' = near-real-time NRT data (now / last days).",
      inputSchema: z.object({
        mode: z.enum(["archival", "realtime"]).optional().describe("Omit to use the map's active tab."),
        bbox: bboxArg,
        from: date.optional(),
        to: date.optional()
      }),
      execute: withErrors(
        async (args: { mode?: "archival" | "realtime"; bbox?: Bbox; from?: string; to?: string }) => {
          const ctx = getContext();
          const bbox = resolveBbox(args.bbox, ctx);
          if (!bbox) return NO_AREA;
          const today = new Date().toISOString().slice(0, 10);
          return data.getSpotsSummary({
            mode: args.mode ?? ctx?.tab ?? "archival",
            bbox,
            from: args.from ?? ctx?.from ?? today,
            to: args.to ?? ctx?.to ?? today
          });
        }
      )
    }),

    get_month_to_date: tool({
      description:
        "Realtime: this month's harmonized activity so far in the region containing an area (region-level) compared with the historical median for the same days of the month. Use for 'is this a bad month / how does now compare' questions; for 'what is burning now' call get_spots_summary (mode realtime) first.",
      inputSchema: z.object({ bbox: bboxArg }),
      execute: withErrors(async (args: { bbox?: Bbox }) => {
        const bbox = resolveBbox(args.bbox, getContext());
        if (!bbox) return NO_AREA;
        return data.getMonthToDate({ bbox });
      })
    }),

    get_app_help: tool({
      description:
        "The site's own guide. Call it for any question about this site or app: what it is, what Realtime, Live, Replay, Archival, the showcase periods or the calendar show, how to do something here (open an incident, start the replay, read the calendar, Raw vs Harmonized, export CSV), what a term on the site means (FRP, cell-days, grid coverage, activity status, Persistent heat, Gas flare, Volcanic heat), its limits, or who built it. Topics: about, views, howto, terms, limits, credits; 'all' returns every section.",
      inputSchema: z.object({
        topic: z.enum([...GUIDE_TOPICS, "all"]).describe("The guide section to read; 'all' when unsure.")
      }),
      execute: withErrors(({ topic }: { topic: (typeof GUIDE_TOPICS)[number] | "all" }) => {
        const sections = topic === "all" ? GUIDE : [guideSection(topic)!];
        return {
          sections: sections.map((s) => ({ topic: s.id, title: s.title, text: s.body })),
          note: "This is the site's guide. Answer from it in your own short words; do not add features or numbers it does not state."
        };
      })
    }),

    remember: tool({
      description:
        "Save a long-term memory for this user: 'aoi' for a named area they care about (include its bbox), 'preference' for units/language/metrics, 'finding' for a notable result you reported. Only save things worth recalling in later conversations.",
      inputSchema: z.object({
        kind: z.enum(MEMORY_KINDS),
        content: z.string().min(1).max(500).describe("One self-contained sentence.")
      }),
      execute: withErrors(({ kind, content }: { kind: (typeof MEMORY_KINDS)[number]; content: string }) => {
        const { saved, duplicate } = memory.remember(kind, content);
        return { ok: true, duplicate, memory: saved };
      })
    }),

    recall: tool({
      description: "Search saved long-term memories by keywords (e.g. a place name the user used before).",
      inputSchema: z.object({ query: z.string().min(1).max(200) }),
      execute: withErrors(({ query }: { query: string }) => {
        const matches = memory.search(query);
        return { count: matches.length, memories: matches };
      })
    })
  };
}
