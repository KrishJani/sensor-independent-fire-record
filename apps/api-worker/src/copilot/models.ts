export const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";
export const DEFAULT_FALLBACK_MODEL = "@cf/zai-org/glm-4.7-flash";

/**
 * CHAT_FALLBACK_MODEL: unset → the default fallback; "" → no fallback (the demo setting, see
 * CHAT.md); otherwise that model, unless it equals the primary.
 */
export function chatFallbacks(raw: string | undefined, primary: string): string[] {
  const fallback = raw === undefined ? DEFAULT_FALLBACK_MODEL : raw.trim();
  return fallback && fallback !== primary ? [fallback] : [];
}
