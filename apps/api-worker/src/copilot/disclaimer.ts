import type { UIMessageChunk } from "ai";

/**
 * Deterministic demo-data notice. Models do not reliably follow "start your
 * answer with this sentence" (kimi-k2.6, glm-4.7-flash and gpt-oss-120b all
 * ignored it in smoke runs), so the server inserts it instead: at the start of
 * the first text written after a mock data tool result in the turn.
 */

export const SYNTHETIC_TOOLS = new Set(["get_calendar", "get_month_to_date"]);
export const SAMPLE_TOOLS = new Set(["get_spots_summary"]);

export const SYNTHETIC_NOTICE =
  "_Demo data: the calendar figures below are synthetic, not satellite observations._";
export const SAMPLE_NOTICE =
  "_Demo data source: hotspot counts are real NASA FIRMS sample detections, but the sample only covers California, 15–19 Aug 2020 (plus a few detections on 2026-11-13)._";
const SAMPLE_ADDENDUM =
  " _Hotspot counts are real NASA FIRMS sample detections (California, 15–19 Aug 2020 only)._";

export function noticeFor(used: { synthetic: boolean; sample: boolean }): string | null {
  if (used.synthetic) return SYNTHETIC_NOTICE + (used.sample ? SAMPLE_ADDENDUM : "");
  if (used.sample) return SAMPLE_NOTICE;
  return null;
}

const isMockOutput = (output: unknown) =>
  typeof output === "object" && output !== null && (output as { dataSource?: unknown }).dataSource === "mock";

/** Insert the demo-data notice into a UI message chunk stream (once per turn). */
export function demoDisclaimerTransform(): TransformStream<UIMessageChunk, UIMessageChunk> {
  const toolNames = new Map<string, string>();
  const used = { synthetic: false, sample: false };
  let injected = false;

  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.type === "tool-input-available") {
        toolNames.set(chunk.toolCallId, chunk.toolName);
      } else if (chunk.type === "tool-output-available" && isMockOutput(chunk.output)) {
        const name = toolNames.get(chunk.toolCallId) ?? "";
        if (SYNTHETIC_TOOLS.has(name)) used.synthetic = true;
        if (SAMPLE_TOOLS.has(name)) used.sample = true;
      }
      controller.enqueue(chunk);
      if (chunk.type === "text-start" && !injected) {
        const notice = noticeFor(used);
        if (notice) {
          injected = true;
          controller.enqueue({ type: "text-delta", id: chunk.id, delta: `${notice}\n\n` });
        }
      }
    }
  });
}
