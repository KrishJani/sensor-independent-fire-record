/** AI Gateway catalog id (Claude Haiku 5.5), billed through Unified Billing or a key stored on the gateway. */
export const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
export const DEFAULT_FALLBACK_MODEL = "@cf/zai-org/glm-4.7-flash";

/**
 * CHAT_REASONING_EFFORT: unset/"" → the model's default; "none"/"off" → reasoning off (sent as
 * reasoning_effort null: agents/models turns it off on Workers AI models that support it, such as
 * the glm fallback, and drops it with a warning for Claude, which does not reason unless asked);
 * "low" | "medium" | "high" pass through as reasoning_effort (do not use them with Claude Haiku).
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
