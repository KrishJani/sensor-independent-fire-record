#!/usr/bin/env node
// End-to-end smoke test for FireCopilotAgent over WebSocket, with answer-quality checks.
//
//   pnpm --filter api-worker dev      # in one terminal (see CHAT.md)
//   pnpm --filter api-worker smoke    # in another
//
// Env: HOST (default localhost:8787), SESSION (default: random UUID), SMOKE_DEBUG=1 (log chunk types),
//      SMOKE_JSON=1 prints a one-line JSON result at the end (used by compare-models).
// Speaks the same cf_agent_use_chat_request protocol as useAgentChat.
//
// Checks (FAIL = exit 1, WARN = reported only):
//   both turns  FAIL  reply contains CJK characters (language drift)
//               WARN  reply says "your area" (the user never said it is theirs)
//   turn 1      FAIL  get_spots_summary was not called
//               FAIL  mock data was used and the first sentence does not mention demo/synthetic
//               FAIL  a bracketed source name without a link, e.g. "[Wikipedia; CAL FIRE]" or "[link]"
//   turn 2      FAIL  neither web_search nor web_fetch was called
//               FAIL  a page read with web_fetch is not cited (linked) in the reply

import { randomUUID } from "node:crypto";
import { AgentClient } from "agents/client";

const HOST = process.env.HOST ?? "localhost:8787";
const SESSION = process.env.SESSION ?? `smoke-${randomUUID()}`;
const JSON_OUT = process.env.SMOKE_JSON === "1";
const DEBUG = process.env.SMOKE_DEBUG === "1"; // print every stream chunk type
const TURN_TIMEOUT_MS = 240_000;

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

// ---------- checks (exported shape kept simple so they are easy to read) ----------

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;

/** First sentence of the reply, ignoring markdown decoration and leading blank lines. */
export function firstSentence(text) {
  const plain = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .trim();
  return (plain.split(/(?<=[.!?])\s+|\n/)[0] ?? "").trim();
}

/** Normalize a URL for comparison: lowercase host, no www, no hash/query, no trailing slash. */
export function normUrl(u) {
  try {
    const url = new URL(u);
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
    return `${url.hostname.replace(/^www\./, "").toLowerCase()}${path}`;
  } catch {
    return u;
  }
}

export function citedUrls(text) {
  return [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => normUrl(m[1]));
}

function checkTurn(turnIndex, t) {
  const fails = [];
  const warns = [];
  if (CJK.test(t.text)) fails.push("reply contains CJK characters");
  if (/\byour area\b/i.test(t.text)) warns.push('says "your area"');
  for (const m of t.text.matchAll(/\[([A-Za-z][^\]\n]{1,60})\](?!\()/g))
    fails.push(`source named without a link: "[${m[1]}]"`);
  if (turnIndex === 0) {
    if (!t.tools.includes("get_spots_summary")) fails.push("get_spots_summary not called");
    if (t.usedMock && !/\b(demo|synthetic)\b/i.test(firstSentence(t.text)))
      fails.push(`mock data used but first sentence lacks demo/synthetic: "${firstSentence(t.text)}"`);
  } else {
    if (!t.tools.some((n) => n === "web_search" || n === "web_fetch")) fails.push("no web tool called");
    const cited = new Set(citedUrls(t.text));
    for (const u of t.fetched) {
      if (![u.url, u.finalUrl].filter(Boolean).some((x) => cited.has(normUrl(x))))
        fails.push(`fetched but not cited: ${u.finalUrl ?? u.url}`);
    }
  }
  return { fails, warns };
}

// ---------- protocol ----------

const client = new AgentClient({ agent: "FireCopilotAgent", name: SESSION, host: HOST });
let transcript = []; // UIMessages, kept in sync from server broadcasts
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
      chunk = { type: "raw", text: msg.body };
    }
    if (DEBUG) console.error(`[chunk] ${chunk.type}${chunk.finishReason ? " " + chunk.finishReason : ""}${chunk.type === "reasoning-delta" ? " " + JSON.stringify(chunk.delta) : ""}`);
    switch (chunk.type) {
      case "text-delta":
        current.text += chunk.delta ?? "";
        if (!JSON_OUT) process.stdout.write(chunk.delta ?? "");
        break;
      case "tool-input-available":
        current.tools.push(chunk.toolName);
        current.inputs.set(chunk.toolCallId, { name: chunk.toolName, input: chunk.input });
        if (!JSON_OUT) process.stdout.write(`\n  🔧 ${chunk.toolName}(${JSON.stringify(chunk.input)})\n`);
        break;
      case "tool-output-available": {
        const call = current.inputs.get(chunk.toolCallId);
        const out = chunk.output;
        if (out && typeof out === "object" && out.dataSource === "mock") current.usedMock = true;
        if (call?.name === "web_fetch" && out && typeof out === "object" && (out.status ?? 200) < 400)
          current.fetched.push({ url: out.url ?? call.input?.url, finalUrl: out.finalUrl });
        if (!JSON_OUT) {
          const s = JSON.stringify(out);
          process.stdout.write(`  ✅ ${s.length > 220 ? s.slice(0, 220) + "…" : s}\n`);
        }
        break;
      }
      case "tool-output-error":
        if (!JSON_OUT) process.stdout.write(`  ❌ tool error: ${chunk.errorText}\n`);
        break;
      case "error":
        current.error = chunk.errorText;
        if (!JSON_OUT) process.stdout.write(`\n  ⚠️  stream error: ${chunk.errorText}\n`);
        break;
      case "raw":
        current.text += chunk.text;
        break;
    }
  }
  if (msg.done || msg.error) {
    const c = current;
    current = null;
    if (msg.error || c.error) c.reject(new Error(c.error ?? msg.body ?? "request failed"));
    else c.resolve(c);
  }
});

async function ask(text) {
  const userMessage = { id: randomUUID(), role: "user", parts: [{ type: "text", text }] };
  const messages = [...transcript, userMessage];
  const id = randomUUID();
  if (!JSON_OUT) console.log(`\n━━━ USER: ${text}\n━━━ ASSISTANT:`);
  const done = new Promise((resolve, reject) => {
    current = { id, resolve, reject, text: "", tools: [], inputs: new Map(), fetched: [], usedMock: false };
    setTimeout(() => reject(new Error(`no answer within ${TURN_TIMEOUT_MS / 1000}s`)), TURN_TIMEOUT_MS);
  });
  client.send(
    JSON.stringify({
      type: "cf_agent_use_chat_request",
      id,
      init: { method: "POST", body: JSON.stringify({ messages, trigger: "submit-message", context }) }
    })
  );
  const started = Date.now();
  const result = await done;
  result.ms = Date.now() - started;
  transcript = messages; // the server broadcast replaces this with the persisted transcript
  await new Promise((r) => setTimeout(r, 300));
  if (!JSON_OUT) console.log(`\n━━━ tools called: ${result.tools.join(", ") || "(none)"} (${result.ms} ms)`);
  return result;
}

async function main() {
  if (!JSON_OUT) console.log(`Connecting to ws://${HOST}/agents/fire-copilot-agent/${SESSION}`);
  await new Promise((resolve, reject) => {
    client.addEventListener("open", resolve, { once: true });
    client.addEventListener("error", () => reject(new Error(`could not connect to ${HOST}`)), { once: true });
  });

  const turns = [];
  for (const q of QUESTIONS) turns.push(await ask(q));
  const checks = turns.map((t, i) => checkTurn(i, t));

  const fails = checks.flatMap((c, i) => c.fails.map((f) => `turn ${i + 1}: ${f}`));
  const warns = checks.flatMap((c, i) => c.warns.map((w) => `turn ${i + 1}: ${w}`));
  if (JSON_OUT) {
    console.log(
      JSON.stringify({
        ok: fails.length === 0,
        fails,
        warns,
        turns: turns.map((t) => ({ tools: t.tools, ms: t.ms, chars: t.text.length, text: t.text }))
      })
    );
  } else {
    console.log("");
    for (const w of warns) console.log(`WARN  ${w}`);
    for (const f of fails) console.log(`FAIL  ${f}`);
    console.log(fails.length ? `\nSMOKE FAILED (${fails.length} check(s))` : "\nSMOKE OK");
  }
  client.close();
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, fails: [`error: ${err.message}`], warns: [], turns: [] }));
  else console.error(`\nSMOKE FAILED: ${err.message}`);
  client.close();
  process.exit(1);
});
