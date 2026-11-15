import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createAI, type CloudflareLanguageModelId } from "agents/models/ai-sdk";
import {
  convertToModelMessages,
  isStepCount,
  streamText,
  type GenerateTextOnFinishCallback,
  type ToolSet
} from "ai";
import { createFireData } from "../data/fireData";
import { parseContext, type MapContext } from "./context";
import { MemoryStore, type SqlTag } from "./memory";
import { buildSystemPrompt } from "./prompt";
import { createFireTools } from "./tools";
import { createWebTools } from "./web";

export interface CopilotState {
  context: MapContext | null;
  contextUpdatedAt: string | null;
}

/** Messages sent to the model per turn (the full transcript stays in SQLite). */
const MODEL_WINDOW = 30;
const FALLBACK_MODEL = "@cf/zai-org/glm-4.7-flash";
const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";

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
    const tools: ToolSet = {
      ...createFireTools({ data, memory: this.memory, getContext: () => this.state.context }),
      ...webTools
    };

    const ai = createAI({ binding: this.env.AI, id: this.env.AI_GATEWAY_ID });
    const model = ai((this.env.CHAT_MODEL || DEFAULT_MODEL) as CloudflareLanguageModelId, {
      fallback: [FALLBACK_MODEL]
    });

    const result = streamText({
      model,
      system: buildSystemPrompt({
        today: new Date().toISOString().slice(0, 10),
        context: this.state.context,
        memories: this.memory.list(),
        dataSource: data.source,
        webSearchEnabled: "web_search" in webTools
      }),
      messages: await convertToModelMessages(this.messages.slice(-MODEL_WINDOW), {
        tools,
        ignoreIncompleteToolCalls: true
      }),
      tools,
      stopWhen: isStepCount(6),
      abortSignal: options?.abortSignal,
      onFinish,
      onError: ({ error }) => console.error("[copilot] stream error:", error)
    });

    return result.toUIMessageStreamResponse({ onError: toUserError });
  }
}

/** Short, non-leaky error text for the chat UI (full error is in the worker log). */
function toUserError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (/configure AI Gateway/i.test(msg))
    return "The AI Gateway is not set up for this account (see CHAT.md → Setup).";
  if (/rate.?limit|429/i.test(msg)) return "The assistant is rate-limited right now. Please retry in a minute.";
  return "The assistant could not answer right now. Please try again.";
}
