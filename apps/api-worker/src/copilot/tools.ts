import { tool } from "ai";
import { z } from "zod";
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

export function createFireTools({ data, memory, getContext }: ToolDeps) {
  return {
    get_calendar: tool({
      description:
        "Harmonized MODIS+VIIRS burning-activity calendar (archival) for an area: peak month/year, critical fire-season months, climatology (median, P10–P90 per calendar month), annual totals and the most anomalous months. Unit: active cell-days. Use for history, seasonality and 'how unusual was X' questions.",
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
        return data.getCalendar({
          bbox,
          from: args.from ?? ctx?.from ?? "2000-11-01",
          to: args.to ?? ctx?.to ?? new Date().toISOString().slice(0, 10),
          months: args.months ?? null
        });
      })
    }),

    get_spots_summary: tool({
      description:
        "Hotspot detections in an area and date range: detection counts, active cell-days per satellite, daily activity, last-seen time and the top detections by fire radiative power (FRP, MW, labelled by sensor). mode 'archival' = finalized FIRMS SP data, 'realtime' = near-real-time NRT data.",
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
        "Realtime: this month's harmonized activity so far in an area compared with the historical median for the same days of the month. Use for 'is this a bad month / how does now compare' questions.",
      inputSchema: z.object({ bbox: bboxArg }),
      execute: withErrors(async (args: { bbox?: Bbox }) => {
        const bbox = resolveBbox(args.bbox, getContext());
        if (!bbox) return NO_AREA;
        return data.getMonthToDate({ bbox });
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
