import { tool, type UIMessage } from "ai";
import { z } from "zod";
import { parseContext, type MapContext } from "./context";

/**
 * Client-side UI tools: defined here (schemas the model sees) with no execute, so the AI SDK hands each
 * call to the browser, which acts on the map (apps/web/src/chat/uiTools.ts) and returns
 * { ok, summary, context? }. The chat shows `summary` as the tool line ("Switched to Replay").
 */

export const UI_TOOLS = ["switch_view", "open_showcase", "fly_to", "start_replay"] as const;
export const SHOWCASE_IDS = ["california-2020-08", "quebec-2023-06"] as const;
export const REPLAY_SCENARIOS = ["quebec-2023-06"] as const;

export function createUiTools() {
  return {
    switch_view: tool({
      description:
        "Switch the map to a view: 'live' (current fires, Realtime tab), 'replay' (the Replay mode, without starting a replay) or 'archival' (history and the calendar). Use when it helps answer, e.g. the user asks about live fires while the map shows history.",
      inputSchema: z.object({ view: z.enum(["live", "replay", "archival"]) })
    }),
    open_showcase: tool({
      description:
        "Open a showcase period on the Archival map with the calendar: 'california-2020-08' (California, Aug–Sep 2020, harmonized) or 'quebec-2023-06' (Quebec, 1–10 June 2023, raw VIIRS detections). Use when the user wants to see one of these periods on the map.",
      inputSchema: z.object({ period: z.enum(SHOWCASE_IDS) })
    }),
    fly_to: tool({
      description:
        "Move the map to a place. Give the center in degrees and a zoom (3 = a large country, 6 = a state or province, 9 = a county, 11 = a town) and the place name as label. Only moves the camera.",
      inputSchema: z.object({
        lon: z.number().min(-180).max(180),
        lat: z.number().min(-85).max(85),
        zoom: z.number().min(1).max(14).optional().describe("Default 7."),
        label: z.string().max(80).describe("Place name, e.g. 'northern Alberta'.")
      })
    }),
    start_replay: tool({
      description:
        "Start the Quebec June 2023 replay, or join it if it is already running (one replay is shared by every visitor). Call ONLY when the user explicitly asks to start, play, watch or run the replay. Never call it on your own initiative, and never to answer a question.",
      inputSchema: z.object({ scenario: z.enum(REPLAY_SCENARIOS) })
    })
  };
}

const UI = new Set<string>(UI_TOOLS);

const uiParts = (m: UIMessage | undefined) =>
  m?.role === "assistant"
    ? m.parts.filter((part) => {
        const p = part as { type: string };
        return p.type.startsWith("tool-") && UI.has(p.type.slice(5));
      })
    : [];

/**
 * True when this request continues a turn whose map action already ran. One map action per turn: a second
 * one tends to undo the first (glm opened the Quebec showcase, then switched to Live).
 */
export function continuesAfterUiTool(messages: UIMessage[]): boolean {
  return uiParts(messages.at(-1)).length > 0;
}

/** Tool names usable in this request: all of them, minus the UI tools once the turn has acted on the map. */
export function activeToolNames(all: string[], messages: UIMessage[]): string[] {
  return continuesAfterUiTool(messages) ? all.filter((n) => !UI.has(n)) : all;
}

/**
 * The map context a UI tool reported after it acted, if it is newer than the request body's. A client tool
 * result continues the turn with the original request body, so without this the model would still see the
 * map as it was before the action.
 */
export function contextFromUiResults(messages: UIMessage[]): MapContext | null {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return null;
  for (const part of [...last.parts].reverse()) {
    const p = part as { type: string; state?: string; output?: { context?: unknown } };
    if (!p.type.startsWith("tool-") || !UI.has(p.type.slice(5)) || p.state !== "output-available") continue;
    const ctx = parseContext(p.output?.context);
    if (ctx) return ctx;
  }
  return null;
}
