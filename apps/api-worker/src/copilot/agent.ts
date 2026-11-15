import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createAI, type CloudflareLanguageModelId } from "agents/models/ai-sdk";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  type GenerateTextOnFinishCallback,
  type ToolSet
} from "ai";
import { createFireData } from "../data/fireData";
import { parseContext, type MapContext } from "./context";
import { demoDisclaimerTransform } from "./disclaimer";
import { MemoryStore, type SqlTag } from "./memory";
import { answerPostProcessor, collectWebUrls, userOwnsArea } from "./postprocess";
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
const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";
const DEFAULT_FALLBACK_MODEL = "@cf/zai-org/glm-4.7-flash";

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
    const tools: ToolSet = {
      ...createFireTools({ data, memory: this.memory, getContext: () => this.state.context }),
      ...realtimeTools,
      ...webTools
    };

    const ai = createAI({ binding: this.env.AI, id: this.env.AI_GATEWAY_ID });
    const primary = (this.env.CHAT_MODEL || DEFAULT_MODEL) as CloudflareLanguageModelId;
    const fallback = (this.env.CHAT_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL) as CloudflareLanguageModelId;
    const model = ai(primary, { fallback: fallback === primary ? [] : [fallback] });

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
      onFinish,
      onError: ({ error }) => console.error("[copilot] stream error:", error)
    });

    let stream = result.toUIMessageStream({ onError: toUserError });
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
