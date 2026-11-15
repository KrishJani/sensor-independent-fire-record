export const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";
export const DEFAULT_FALLBACK_MODEL = "@cf/zai-org/glm-4.7-flash";

/**
 * CHAT_REASONING_EFFORT: unset/"" → the model's default (kimi-k2.6: high); "none"/"off" → reasoning
 * off (sent as reasoning_effort null, which agents/models maps to the model's "off"); "low" |
 * "medium" | "high" pass through (kimi-k2.6 maps low/medium to high).
 */
export function chatReasoningEffort(raw: string | undefined): "low" | "medium" | "high" | null | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "none" || v === "off") return null;
  if (v === "low" || v === "medium" || v === "high") return v;
  return undefined;
}

/** CHAT_CACHE_TTL: AI Gateway response cache TTL in seconds; unset/0/invalid → off. */
export function chatCacheTtl(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * CHAT_FALLBACK_MODEL: unset → the default fallback; "" → no fallback (the demo setting, see
 * CHAT.md); otherwise that model, unless it equals the primary.
 */
export function chatFallbacks(raw: string | undefined, primary: string): string[] {
  const fallback = raw === undefined ? DEFAULT_FALLBACK_MODEL : raw.trim();
  return fallback && fallback !== primary ? [fallback] : [];
}

/** Label for logs/metadata: null (off) → "none", undefined → "default". */
export const effortLabel = (e: "low" | "medium" | "high" | null | undefined) => (e === null ? "none" : (e ?? "default"));

type RunBinding = { run(model: string, input: unknown, options?: unknown): Promise<unknown> };

/**
 * agents/models treats moonshotai (kimi) as "reasoning cannot be turned off" and drops
 * reasoning_effort: null, but Workers AI kimi-k2.6 accepts reasoning_effort "none" (measured:
 * ~2 s instead of ~55 s for a brief). This wraps the AI binding so kimi chat requests get
 * reasoning_effort "none" when chat reasoning is off. Other methods pass through unchanged.
 */
export function withKimiReasoningOff<T extends object>(binding: T): T {
  return new Proxy(binding, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "run" && typeof value === "function")
        return (model: string, input: unknown, options?: unknown) => {
          const patched =
            /kimi/i.test(model) && input && typeof input === "object" && "messages" in input ? { ...(input as object), reasoning_effort: "none" } : input;
          return (value as RunBinding["run"]).call(target, model, patched, options);
        };
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
