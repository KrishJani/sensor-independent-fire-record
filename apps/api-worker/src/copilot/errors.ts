/** Short, non-leaky error text for the chat UI (full error is in the worker log). */
export function toUserError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (/deprecated|\b410\b|internalCode"?:\s*5028/i.test(msg))
    return "The AI model behind this assistant has been retired by Cloudflare. The site owner needs to pick a new model (CHAT_MODEL).";
  if (/spend limit|budget|usage limit/i.test(msg))
    return "The assistant's AI Gateway spend limit has been reached. Please try again later.";
  if (/configure AI Gateway/i.test(msg))
    return "The AI Gateway is not set up for this account (see CHAT.md → Setup).";
  if (/daily free allocation|neurons/i.test(msg))
    return "The AI quota for this account is used up for today (Workers AI free allocation). Try again tomorrow or upgrade to Workers Paid.";
  if (/rate.?limit|429/i.test(msg)) return "The assistant is rate-limited right now. Please retry in a minute.";
  return "The assistant could not answer right now. Please try again.";
}
