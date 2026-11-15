import type { ToolSet } from "ai";

/** One model step: model time = step time minus the tool calls executed in it. */
export interface StepTiming {
  step: number;
  ms: number;
  modelMs: number;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  tools: { name: string; ms: number; ok: boolean }[];
}

export interface TurnTiming {
  totalMs: number;
  modelMs: number;
  toolMs: number;
  reasoningTokens: number;
  outputTokens: number;
  steps: StepTiming[];
}

type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  outputTokenDetails?: { reasoningTokens?: number };
};

/**
 * Per-turn instrumentation: wraps every tool's execute to time it, and records each model step's
 * duration and token usage (from onStepStart / onStepFinish). Sent to the client as message
 * metadata ({ timing }) and logged as copilot_turn_timing.
 */
export class TurnTimer {
  readonly started = Date.now();
  #stepStart = this.started;
  #pendingTools: StepTiming["tools"] = [];
  readonly steps: StepTiming[] = [];

  wrapTools<T extends ToolSet>(tools: T): T {
    const out: Record<string, unknown> = {};
    for (const [name, t] of Object.entries(tools)) {
      const exec = (t as { execute?: (...a: unknown[]) => unknown }).execute;
      if (!exec) {
        out[name] = t;
        continue;
      }
      out[name] = {
        ...t,
        execute: async (...args: unknown[]) => {
          const t0 = Date.now();
          let ok = true;
          try {
            const r = await exec(...args);
            ok = !(r && typeof r === "object" && "error" in r);
            return r;
          } catch (err) {
            ok = false;
            throw err;
          } finally {
            this.#pendingTools.push({ name, ms: Date.now() - t0, ok });
          }
        }
      };
    }
    return out as T;
  }

  stepStart() {
    this.#stepStart = Date.now();
  }

  stepFinish(e: { usage?: Usage; finishReason?: string }) {
    const ms = Date.now() - this.#stepStart;
    const tools = this.#pendingTools;
    this.#pendingTools = [];
    const toolMs = tools.reduce((a, t) => a + t.ms, 0);
    const u = e.usage ?? {};
    this.steps.push({
      step: this.steps.length,
      ms,
      modelMs: Math.max(0, ms - toolMs),
      finishReason: e.finishReason ?? null,
      inputTokens: u.inputTokens ?? null,
      outputTokens: u.outputTokens ?? null,
      reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? u.reasoningTokens ?? null,
      tools
    });
    this.#stepStart = Date.now();
  }

  summary(): TurnTiming {
    const sum = (f: (s: StepTiming) => number) => this.steps.reduce((a, s) => a + f(s), 0);
    return {
      totalMs: Date.now() - this.started,
      modelMs: sum((s) => s.modelMs),
      toolMs: sum((s) => s.tools.reduce((a, t) => a + t.ms, 0)),
      reasoningTokens: sum((s) => s.reasoningTokens ?? 0),
      outputTokens: sum((s) => s.outputTokens ?? 0),
      steps: this.steps
    };
  }
}
