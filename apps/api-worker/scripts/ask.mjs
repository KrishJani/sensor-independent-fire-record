#!/usr/bin/env node
// Asks the copilot one or more questions in one fresh session and prints each tool call and the reply.
//
//   HOST=nasa-fire-api.<subdomain>.workers.dev node scripts/ask.mjs "What is this site?" "How do I export CSV?"
//
// Env: HOST (default localhost:8787), TAB (realtime | archival, default realtime),
//      STREAM (default live; e.g. replay:<id>).
// UI tools (switch_view, open_showcase, fly_to, start_replay) run in the browser; here they are answered with
// a simulated result in the web app's shape ({ ok, summary, context }) and nothing on the map changes.
// START_REPLAY_RESULT=started|joined|cooldown picks what start_replay reports (default joined).

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
        realtimeStream: STREAM
      };

const UI_TOOLS = new Set(["switch_view", "open_showcase", "fly_to", "start_replay"]);
const SHOWCASE = { "california-2020-08": "California, Aug–Sep 2020", "quebec-2023-06": "Quebec, 1–10 June 2023" };
function simulateUi(name, input) {
  const realtime = (stream) => ({ tab: "realtime", aoi: null, from: "2026-11-23", to: "2026-11-25", ...(stream ? { realtimeStream: stream } : {}) });
  switch (name) {
    case "switch_view": {
      const label = { live: "Live", replay: "Replay", archival: "Archival" }[input.view];
      const ctx = input.view === "archival" ? { tab: "archival", aoi: null, from: "2020-08-01", to: "2020-08-31" } : realtime(input.view === "live" ? "live" : null);
      return { ok: true, summary: `Switched to ${label}`, context: ctx };
    }
    case "open_showcase":
      return { ok: true, summary: `Opened ${SHOWCASE[input.period]}`, context: { tab: "archival", aoi: { bbox: [-124.5, 32.5, -114, 42] }, from: "2020-08-01", to: "2020-08-31" } };
    case "fly_to":
      return { ok: true, summary: `Moved the map to ${input.label}`, context: { ...context, aoi: { bbox: [input.lon - 3, input.lat - 2, input.lon + 3, input.lat + 2], label: input.label } } };
    case "start_replay": {
      const kind = process.env.START_REPLAY_RESULT ?? "joined";
      const ctx = { ...realtime("replay:askstub01"), from: "2023-06-01", to: "2023-06-10" };
      if (kind === "cooldown")
        return { ok: true, summary: "Quebec 2023 replay starts in 18s", note: "Another replay was started moments ago; this one starts automatically in about 18 seconds.", context: realtime(null) };
      return { ok: true, summary: kind === "started" ? "Started the Quebec 2023 replay" : "Joined the Quebec 2023 replay already running", context: ctx };
    }
  }
}

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
  // After a UI tool result the server continues the turn under a new request id, announced as a stream to
  // resume; it only streams the chunks once acknowledged (useAgentChat does this in the browser).
  if (msg.type === "cf_agent_stream_resuming") {
    client.send(JSON.stringify({ type: "cf_agent_stream_resume_ack", id: msg.id }));
    return;
  }
  if (msg.type !== "cf_agent_use_chat_response" || !current || (current.id !== null && msg.id !== current.id)) return;
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
    if (msg.error) {
      current = null;
      return c.reject(new Error(msg.body ?? "request failed"));
    }
    const pending = c.tools.filter((t) => UI_TOOLS.has(t.name) && !t.answered);
    if (pending.length) {
      for (const t of pending) {
        t.answered = true;
        const output = simulateUi(t.name, t.input);
        console.log(`  ⇠ ${t.name}: ${output.summary}`);
        client.send(JSON.stringify({ type: "cf_agent_tool_result", toolCallId: t.id, toolName: t.name, output, autoContinue: true }));
      }
      c.id = null; // accept the continuation's response
      c.text += c.text && !/\s$/.test(c.text) ? " " : "";
      return;
    }
    current = null;
    c.resolve(c);
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
