#!/usr/bin/env node
// Asks the copilot one or more questions in one fresh session and prints each tool call and the reply.
//
//   HOST=nasa-fire-api.<subdomain>.workers.dev node scripts/ask.mjs "What is this site?" "How do I export CSV?"
//
// Env: HOST (default localhost:8787), TAB (realtime | archival, default realtime),
//      STREAM (default live; e.g. replay:<id>), MODE (live | replay, default from STREAM).
// Client-side tools (tools the browser runs) are answered with { ok: true } and printed, as the web app would.

import { randomUUID } from "node:crypto";
import { AgentClient } from "agents/client";

const HOST = process.env.HOST ?? "localhost:8787";
const TAB = process.env.TAB ?? "realtime";
const STREAM = process.env.STREAM ?? "live";
const TIMEOUT_MS = 180_000;
const questions = process.argv.slice(2);
if (!questions.length) {
  console.error('usage: node scripts/ask.mjs "question" ["follow-up" ...]');
  process.exit(2);
}

const context =
  TAB === "archival"
    ? { tab: "archival", aoi: null, from: "2020-08-01", to: "2020-08-31" }
    : {
        tab: "realtime",
        aoi: null,
        from: "2026-11-23",
        to: "2026-11-25",
        realtime: { mode: process.env.MODE ?? (STREAM.startsWith("replay:") ? "replay" : "live"), stream: STREAM, label: null }
      };

const client = new AgentClient({ agent: "FireCopilotAgent", name: `ask-${randomUUID()}`, host: HOST });
let transcript = [];
let current = null;

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
      return;
    }
    if (chunk.type === "text-delta") current.text += chunk.delta ?? "";
    if (chunk.type === "tool-input-available") {
      current.tools.push({ id: chunk.toolCallId, name: chunk.toolName, input: chunk.input });
      console.log(`  → ${chunk.toolName} ${JSON.stringify(chunk.input)}`);
    }
    if (chunk.type === "finish") current.finish = chunk;
  }
  if (msg.done || msg.error) {
    const c = current;
    current = null;
    if (msg.error) c.reject(new Error(msg.body ?? "request failed"));
    else c.resolve(c);
  }
});

async function ask(text) {
  const userMessage = { id: randomUUID(), role: "user", parts: [{ type: "text", text }] };
  const messages = [...transcript, userMessage];
  const id = randomUUID();
  console.log(`\n━━━ USER: ${text}`);
  const t0 = Date.now();
  const done = new Promise((resolve, reject) => {
    current = { id, resolve, reject, text: "", tools: [] };
    setTimeout(() => reject(new Error(`no answer within ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
  });
  client.send(
    JSON.stringify({
      type: "cf_agent_use_chat_request",
      id,
      init: { method: "POST", body: JSON.stringify({ messages, trigger: "submit-message", context }) }
    })
  );
  const r = await done;
  await new Promise((res) => setTimeout(res, 300));
  console.log(`━━━ ASSISTANT (${((Date.now() - t0) / 1000).toFixed(1)} s):\n${r.text.trim()}`);
  return r;
}

await new Promise((resolve, reject) => {
  client.addEventListener("open", resolve, { once: true });
  client.addEventListener("error", () => reject(new Error(`could not connect to ${HOST}`)), { once: true });
});
for (const q of questions) await ask(q);
client.close();
process.exit(0);
