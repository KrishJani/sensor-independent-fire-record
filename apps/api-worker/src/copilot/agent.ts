import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createAI, type CloudflareLanguageModelId } from "agents/models/ai-sdk";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  type GenerateTextOnFinishCallback,
  type UIMessageChunk,
  type ToolSet
} from "ai";
import { createFireData } from "../data/fireData";
import { parseContext, type MapContext } from "./context";
import { demoDisclaimerTransform } from "./disclaimer";
import { MemoryStore, type SqlTag } from "./memory";
import { answerPostProcessor, collectWebUrls, userOwnsArea } from "./postprocess";
import { chatCacheTtl, chatFallbacks, chatReasoningEffort, DEFAULT_MODEL, effortLabel, withKimiReasoningOff } from "./models";
import { TurnTimer, type TurnTiming } from "./timing";
import { buildSystemPrompt } from "./prompt";
import { createRealtimeTools } from "./realtime";
import { createFireTools } from "./tools";
import { createWebTools } from "./web";

export interface CopilotState {
  context: MapContext | null;
  contextUpdatedAt: string | null;
}

/** Messages sent to the model per turn (the full transcript stays in SQLite). */
const MODEL_WINDOW = 30;
/** Model steps per turn. The last one is forced to be text-only so a turn never ends mid-tool-loop. */
const MAX_STEPS = 8;
/** Explicit budget: reasoning models (gpt-oss) otherwise truncate answers mid-sentence. */
const MAX_OUTPUT_TOKENS = 4096;

/**
 * One instance per chat session (sessionId = DO name). Transcript persistence,
 * resumable streaming and cancellation come from AIChatAgent.
 */
export class FireCopilotAgent extends AIChatAgent<Env, CopilotState> {
  initialState: CopilotState = { context: null, contextUpdatedAt: null };
  maxPersistedMessages = 200;

  #memory?: MemoryStore;

  get memory(): MemoryStore {
    return (this.#memory ??= new MemoryStore(this.sql.bind(this) as SqlTag));
  }

  async onStart() {
    this.memory.init();
  }

  async onChatMessage(
    onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const incoming = parseContext(options?.body?.context);
    if (incoming) {
      this.setState({ context: incoming, contextUpdatedAt: new Date().toISOString() });
    }

    const data = createFireData(this.env);
    const webTools = createWebTools(this.env);
    const realtimeTools = createRealtimeTools(this.env.REALTIME, () => this.state.context);
    const timer = new TurnTimer();
    const tools: ToolSet = timer.wrapTools({
      ...createFireTools({ data, memory: this.memory, getContext: () => this.state.context }),
      ...realtimeTools,
      ...webTools
    });

    const cacheTtl = chatCacheTtl(this.env.CHAT_CACHE_TTL);
    const effort = chatReasoningEffort(this.env.CHAT_REASONING_EFFORT);
    const binding = effort === null ? withKimiReasoningOff(this.env.AI) : this.env.AI;
    const ai = createAI({ binding, id: this.env.AI_GATEWAY_ID, ...(cacheTtl ? { cacheTtl } : {}) });
    const primary = (this.env.CHAT_MODEL || DEFAULT_MODEL) as CloudflareLanguageModelId;
    const fallbacks = chatFallbacks(this.env.CHAT_FALLBACK_MODEL, primary) as CloudflareLanguageModelId[];
    const model = ai(primary, { fallback: fallbacks, ...(effort !== undefined ? { reasoningEffort: effort } : {}) });
    let timing: TurnTiming | null = null;

    const result = streamText({
      model,
      system: buildSystemPrompt({
        today: new Date().toISOString().slice(0, 10),
        context: this.state.context,
        memories: this.memory.list(),
        dataSource: data.source,
        webSearchEnabled: "web_search" in webTools,
        realtimeEnabled: "get_live_incidents" in realtimeTools
      }),
      messages: await convertToModelMessages(this.messages.slice(-MODEL_WINDOW), {
        tools,
        ignoreIncompleteToolCalls: true
      }),
      tools,
      stopWhen: isStepCount(MAX_STEPS),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      prepareStep: ({ stepNumber }) =>
        stepNumber >= MAX_STEPS - 1 ? { toolChoice: "none" as const } : undefined,
      abortSignal: options?.abortSignal,
      onStepStart: () => timer.stepStart(),
      onStepFinish: (step) => timer.stepFinish(step as never),
      onFinish: (event) => {
        timing = timer.summary();
        // Which model actually answered (primary or fallback): needed to trace language drift.
        console.log(JSON.stringify({ msg: "copilot_turn_done", model: event.response?.modelId ?? null, primary, fallbacks, reasoningEffort: effortLabel(effort), finishReason: event.finishReason }));
        console.log(JSON.stringify({ msg: "copilot_turn_timing", ...timing }));
        return onFinish(event);
      },
      onError: ({ error }) => console.error("[copilot] stream error:", error)
    });

    let stream = result.toUIMessageStream({ onError: toUserError });
    // Per-step timing as a message-metadata chunk just before "finish" (the finish chunk's own
    // metadata is replaced downstream). scripts/demo-chat.mjs prints it.
    stream = stream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          if (chunk.type === "finish")
            controller.enqueue({ type: "message-metadata", messageMetadata: { timing: timing ?? timer.summary(), reasoningEffort: effortLabel(effort) } });
          controller.enqueue(chunk);
        }
      })
    );
    if (data.source === "mock") stream = stream.pipeThrough(demoDisclaimerTransform());
    // Last: spacing between text parts, unlink URLs no web tool returned, "your area" → "this area".
    stream = stream.pipeThrough(
      answerPostProcessor({
        knownUrls: collectWebUrls(this.messages),
        rewriteArea: !userOwnsArea(this.messages)
      })
    );
    return createUIMessageStreamResponse({ stream });
  }
}

/** Short, non-leaky error text for the chat UI (full error is in the worker log). */
function toUserError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (/configure AI Gateway/i.test(msg))
    return "The AI Gateway is not set up for this account (see CHAT.md → Setup).";
  if (/daily free allocation|neurons/i.test(msg))
    return "The AI quota for this account is used up for today (Workers AI free allocation). Try again tomorrow or upgrade to Workers Paid.";
  if (/rate.?limit|429/i.test(msg)) return "The assistant is rate-limited right now. Please retry in a minute.";
  return "The assistant could not answer right now. Please try again.";
}
