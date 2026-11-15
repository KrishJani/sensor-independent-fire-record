#!/usr/bin/env node
// End-to-end smoke test for FireCopilotAgent over WebSocket.
//
//   pnpm --filter api-worker dev      # in one terminal (see CHAT.md)
//   pnpm --filter api-worker smoke    # in another
//
// Env: HOST (default localhost:8787), SESSION (default: random UUID).
// Speaks the same cf_agent_use_chat_request protocol as useAgentChat.

import { randomUUID } from "node:crypto";
import { AgentClient } from "agents/client";

const HOST = process.env.HOST ?? "localhost:8787";
const SESSION = process.env.SESSION ?? `smoke-${randomUUID()}`;
const TURN_TIMEOUT_MS = 180_000;

const context = {
  tab: "archival",
  aoi: { bbox: [-124.0, 38.5, -121.5, 41.0], label: "Northern California (Mendocino / Lake / Tehama)" },
  from: "2020-08-01",
  to: "2020-08-31"
};

const QUESTIONS = [
  "What happened in this area in August 2020?",
  "and what does the news say about the August Complex fire?"
];

const client = new AgentClient({ agent: "FireCopilotAgent", name: SESSION, host: HOST });
let transcript = []; // UIMessages, kept in sync from server broadcasts
let current = null; // { id, resolve, reject, tools: [] }

client.addEventListener("message", (event) => {
  if (typeof event.data !== "string") return;
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  if (msg.type === "cf_agent_chat_messages") {
    transcript = msg.messages;
    return;
  }
  if (msg.type !== "cf_agent_use_chat_response" || !current || msg.id !== current.id) return;

  if (msg.body) {
    let chunk;
    try {
      chunk = JSON.parse(msg.body);
    } catch {
      chunk = { type: "raw", text: msg.body };
    }
    switch (chunk.type) {
      case "text-delta":
        process.stdout.write(chunk.delta ?? "");
        break;
      case "tool-input-available":
        current.tools.push(chunk.toolName);
        process.stdout.write(`\n  🔧 ${chunk.toolName}(${JSON.stringify(chunk.input)})\n`);
        break;
      case "tool-output-available": {
        const out = JSON.stringify(chunk.output);
        process.stdout.write(`  ✅ ${out.length > 220 ? out.slice(0, 220) + "…" : out}\n`);
        break;
      }
      case "tool-output-error":
        process.stdout.write(`  ❌ tool error: ${chunk.errorText}\n`);
        break;
      case "error":
        process.stdout.write(`\n  ⚠️  stream error: ${chunk.errorText}\n`);
        current.error = chunk.errorText;
        break;
      case "raw":
        process.stdout.write(chunk.text);
        break;
    }
  }
  if (msg.done || msg.error) {
    const c = current;
    current = null;
    if (msg.error) c.reject(new Error(c.error ?? msg.body ?? "request failed"));
    else c.resolve(c);
  }
});

async function ask(text) {
  const userMessage = { id: randomUUID(), role: "user", parts: [{ type: "text", text }] };
  const messages = [...transcript, userMessage];
  const id = randomUUID();
  console.log(`\n━━━ USER: ${text}\n━━━ ASSISTANT:`);
  const done = new Promise((resolve, reject) => {
    current = { id, resolve, reject, tools: [] };
    setTimeout(() => reject(new Error(`no answer within ${TURN_TIMEOUT_MS / 1000}s`)), TURN_TIMEOUT_MS);
  });
  client.send(
    JSON.stringify({
      type: "cf_agent_use_chat_request",
      id,
      init: { method: "POST", body: JSON.stringify({ messages, trigger: "submit-message", context }) }
    })
  );
  const result = await done;
  transcript = messages; // server broadcast replaces this with the persisted transcript
  await new Promise((r) => setTimeout(r, 300));
  console.log(`\n━━━ tools called: ${result.tools.join(", ") || "(none)"}`);
  return result;
}

async function main() {
  console.log(`Connecting to ws://${HOST}/agents/fire-copilot-agent/${SESSION}`);
  await new Promise((resolve, reject) => {
    client.addEventListener("open", resolve, { once: true });
    client.addEventListener("error", () => reject(new Error(`could not connect to ${HOST}`)), { once: true });
  });
  const first = await ask(QUESTIONS[0]);
  const second = await ask(QUESTIONS[1]);
  const ok =
    first.tools.some((t) => t.startsWith("get_")) &&
    second.tools.includes("web_search");
  console.log(
    ok
      ? "\nSMOKE OK: data tool used on turn 1, web_search on turn 2."
      : "\nSMOKE WARN: expected a data tool on turn 1 and web_search on turn 2 (model choice may vary)."
  );
  client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nSMOKE FAILED: ${err.message}`);
  client.close();
  process.exit(1);
});
