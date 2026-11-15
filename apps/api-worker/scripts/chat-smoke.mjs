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
// Checks (all FAIL = exit 1):
//   both turns  reply contains CJK characters (language drift)
//               two text parts (model steps) glued without a space ("stillin")
//               reply says "your area" (the user never said it is theirs)
//               reply echoes prompt instructions ("You never…", "You do not…")
//               banned filler ("workload", "intense activity")
//               a bracketed source name without a link, e.g. "[Wikipedia; CAL FIRE]" or "[link]"
//               a link to a URL that no web_search/web_fetch call returned in this conversation
//   turn 1      get_spots_summary was not called
//               mock data was used and the first sentence does not mention demo/synthetic
//               no web tool was called but the reply has links or a "Sources" section
//   turn 2      neither web_search nor web_fetch was called
//               a page read with web_fetch is not cited (linked) in the reply

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

/** Raw URLs of markdown links and <autolinks> in the reply. */
export function linkedUrls(text) {
  return [
    ...[...text.matchAll(/\]\(\s*<?(https?:\/\/[^)\s>]+)/g)].map((m) => m[1]),
    ...[...text.matchAll(/<(https?:\/\/[^>\s]+)>/g)].map((m) => m[1])
  ];
}

export function citedUrls(text) {
  return linkedUrls(text).map(normUrl);
}

/** Every URL web_search / web_fetch returned in this conversation (normalized). */
const returnedUrls = new Set();

function checkTurn(turnIndex, t) {
  const fails = [];
  const warns = [];
  if (CJK.test(t.text)) fails.push("reply contains CJK characters");
  for (const g of t.glued) fails.push(`text parts glued without a space: "${g}"`);
  if (/\byour area\b/i.test(t.text)) fails.push('says "your area"');
  const echo = t.text.match(/\bYou (never|do not|don't|must|should never)\b[^.\n]*/);
  if (echo) fails.push(`echoes prompt instructions: "${echo[0]}"`);
  for (const f of t.text.match(/\bworkloads?\b|\bintense activity\b/gi) ?? []) fails.push(`banned filler "${f}"`);
  for (const m of t.text.matchAll(/\[([A-Za-z][^\]\n]{1,60})\](?!\()/g))
    fails.push(`source named without a link: "[${m[1]}]"`);
  for (const u of linkedUrls(t.text))
    if (!returnedUrls.has(normUrl(u))) fails.push(`links a URL no web tool returned: ${u}`);
  const usedWeb = t.tools.some((n) => n === "web_search" || n === "web_fetch");
  if (turnIndex === 0) {
    if (!t.tools.includes("get_spots_summary")) fails.push("get_spots_summary not called");
    if (t.usedMock && !/\b(demo|synthetic)\b/i.test(firstSentence(t.text)))
      fails.push(`mock data used but first sentence lacks demo/synthetic: "${firstSentence(t.text)}"`);
    if (!usedWeb) {
      if (linkedUrls(t.text).length) fails.push("links in a reply that called no web tool");
      if (/^\s*(#{1,6}\s*)?\**\s*sources?\b/im.test(t.text)) fails.push('"Sources" section in a reply that called no web tool');
    }
  } else {
    if (!usedWeb) fails.push("no web tool called");
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
      case "text-start":
        current.newPart = true;
        break;
      case "text-delta": {
        const d = chunk.delta ?? "";
        // A new text part (next model step) must not glue onto the previous word ("stillin").
        if (current.newPart && d) {
          if (/\S$/.test(current.text) && /^\S/.test(d))
            current.glued.push(`${current.text.slice(-15)}|${d.slice(0, 15)}`);
          current.newPart = false;
        }
        current.text += d;
        if (!JSON_OUT) process.stdout.write(d);
        break;
      }
      case "tool-input-available":
        current.tools.push(chunk.toolName);
        current.inputs.set(chunk.toolCallId, { name: chunk.toolName, input: chunk.input });
        if (!JSON_OUT) process.stdout.write(`\n  🔧 ${chunk.toolName}(${JSON.stringify(chunk.input)})\n`);
        break;
      case "tool-output-available": {
        const call = current.inputs.get(chunk.toolCallId);
        const out = chunk.output;
        if (out && typeof out === "object" && out.dataSource === "mock") current.usedMock = true;
        if (call?.name === "web_fetch" && out && typeof out === "object" && (out.status ?? 200) < 400) {
          current.fetched.push({ url: out.url ?? call.input?.url, finalUrl: out.finalUrl });
          for (const u of [out.url, out.finalUrl]) if (typeof u === "string" && u) returnedUrls.add(normUrl(u));
        }
        if (call?.name === "web_search" && Array.isArray(out?.items))
          for (const it of out.items) if (typeof it?.url === "string") returnedUrls.add(normUrl(it.url));
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
    current = { id, resolve, reject, text: "", tools: [], inputs: new Map(), fetched: [], usedMock: false, newPart: false, glued: [] };
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
