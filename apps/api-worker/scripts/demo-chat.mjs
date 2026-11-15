#!/usr/bin/env node
// Asks the demo questions (scripts/demo-questions.md) against a running api-worker + realtime-worker,
// one fresh chat session per question, with the map context set to a quebec-2023-06 replay.
//
//   HOST=nasa-fire-api.kj2743.workers.dev RT_HOST=nasa-fire-realtime.kj2743.workers.dev node scripts/demo-chat.mjs
//
// Env: HOST (api, default localhost:8787), RT_HOST (realtime, default localhost:8789),
//      AT=done (default: wait for the replay to finish, deterministic) | now (ask while it runs) |
//      early (start a new slow replay, SPEED default 20, and ask at once: the empty-result path),
//      ONLY=1,3 (question numbers), REPEAT=n (ask each n times), AOI=quebec (send the scenario bbox
//      as the area; default no area), OUT=file.json (save every turn), QUIET=1.
// Per turn it prints latency, tool calls (input + result summary), per-step model/tool time and
// reasoning tokens (from the server's timing metadata), and simple correctness checks.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentClient } from "agents/client";

const HOST = process.env.HOST ?? "localhost:8787";
const RT_HOST = process.env.RT_HOST ?? "localhost:8789";
const AT = process.env.AT ?? "done";
const REPEAT = Number(process.env.REPEAT ?? 1);
const QUIET = process.env.QUIET === "1";
const TURN_TIMEOUT_MS = 240_000;
const rtBase = `${RT_HOST.startsWith("localhost") ? "http" : "https"}://${RT_HOST}`;
const QUEBEC = { bbox: [-80, 45, -60, 53], from: "2023-06-01", to: "2023-06-10" };

const here = dirname(fileURLToPath(import.meta.url));
let QUESTIONS = [...readFileSync(join(here, "demo-questions.md"), "utf8").matchAll(/^- "(.+)"\s*$/gm)].map((m) => m[1]);
if (process.env.ONLY) {
  const keep = new Set(process.env.ONLY.split(",").map(Number));
  QUESTIONS = QUESTIONS.map((q, i) => [i + 1, q]).filter(([n]) => keep.has(n));
} else QUESTIONS = QUESTIONS.map((q, i) => [i + 1, q]);

const log = (...a) => !QUIET && console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (path) => (await fetch(`${rtBase}${path}`)).json();

// ---- replay ----
const start = await fetch(`${rtBase}/realtime/replay`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scenario: "quebec-2023-06", ...(AT === "early" ? { speed: Number(process.env.SPEED ?? 20) } : {}) })
});
let replay = await start.json();
if (!start.ok) {
  console.error("replay start failed:", start.status, JSON.stringify(replay));
  process.exit(1);
}
log(`replay ${replay.id} (${replay.reused ? "reused" : "new"}, ${replay.status}, ${(replay.progress * 100).toFixed(0)}%)`);
if (AT === "early" && replay.reused) log("note: a replay was already running, so this is not the start of a replay");
if (AT === "done") {
  while (replay.status === "running" || replay.status === "paused") {
    await sleep(3000);
    replay = await getJson(`/realtime/replay/${replay.id}`);
  }
  await sleep(5000); // let enrichment finish for the last incidents
  log(`replay ${replay.status}`);
}
const stream = replay.stream;

// Ground truth for the checks: the largest incident and its enrichment.
async function truth() {
  const list = await getJson(`/realtime/incidents?stream=${stream}&status=all&limit=5`);
  const largest = list.incidents?.[0] ?? null;
  const detail = largest ? await getJson(`/realtime/incidents/${encodeURIComponent(largest.id)}`) : null;
  return { streamT: list.streamT, count: list.count, largest, places: detail?.enrichment?.places ?? null, weather: detail?.enrichment?.weather ?? null };
}

// ---- chat ----
function askOnce(question) {
  return new Promise((resolve, reject) => {
    const session = `demo-${randomUUID()}`;
    const client = new AgentClient({ agent: "FireCopilotAgent", name: session, host: HOST });
    const id = randomUUID();
    const turn = { question, text: "", tools: [], error: null, meta: null, ms: 0 };
    const calls = new Map();
    let t0 = 0;
    const timer = setTimeout(() => {
      client.close();
      reject(new Error(`no answer within ${TURN_TIMEOUT_MS / 1000}s`));
    }, TURN_TIMEOUT_MS);
    client.addEventListener("open", () => {
      const context = {
        tab: "realtime",
        aoi: process.env.AOI === "quebec" ? { bbox: QUEBEC.bbox, label: "Quebec" } : null,
        from: QUEBEC.from,
        to: QUEBEC.to,
        realtimeStream: stream
      };
      const messages = [{ id: randomUUID(), role: "user", parts: [{ type: "text", text: question }] }];
      t0 = Date.now();
      client.send(JSON.stringify({ type: "cf_agent_use_chat_request", id, init: { method: "POST", body: JSON.stringify({ messages, trigger: "submit-message", context }) } }));
    }, { once: true });
    client.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type !== "cf_agent_use_chat_response" || msg.id !== id) return;
      if (msg.body) {
        let c;
        try {
          c = JSON.parse(msg.body);
        } catch {
          c = { type: "raw" };
        }
        if (c.type === "text-delta") turn.text += c.delta ?? "";
        else if (c.type === "tool-input-available") calls.set(c.toolCallId, { name: c.toolName, input: c.input, output: null });
        else if (c.type === "tool-output-available") {
          const call = calls.get(c.toolCallId);
          if (call) call.output = c.output;
        } else if (c.type === "error") turn.error = c.errorText;
        if (c.messageMetadata) turn.meta = { ...(turn.meta ?? {}), ...c.messageMetadata };
      }
      if (msg.done || msg.error) {
        clearTimeout(timer);
        turn.ms = Date.now() - t0;
        turn.tools = [...calls.values()];
        client.close();
        resolve(turn);
      }
    });
  });
}

const num = (s) => s.replace(/,/g, "");
function check(n, turn, gt) {
  const t = num(turn.text);
  const fails = [];
  const names = turn.tools.map((c) => c.name);
  if (turn.error) fails.push(`error: ${turn.error}`);
  if (/\bno (active )?(fires?|incidents?)\b|there are no fires/i.test(turn.text) && gt.count > 0) fails.push('says "no fires" although the stream has incidents');
  for (const m of turn.text.matchAll(/[^.\n]*\bburn(?:ed|t) area\b[^.\n]*/gi))
    if (!/\b(not|n't|never|larger than|overstate|differ|equal)/i.test(m[0])) fails.push(`calls it burned area: "${m[0].trim()}"`);
  if (!turn.text.trim()) fails.push("empty answer");
  if (!names.includes("get_live_incidents")) fails.push("get_live_incidents not called");
  if (gt.largest) {
    const area = Math.round(gt.largest.affectedAreaKm2);
    if (n === 1 && !new RegExp(`\\b${area}|${Math.round(area / 10)}\\d\\b|${(gt.largest.affectedAreaKm2).toFixed(1)}`).test(t))
      fails.push(`largest area ${gt.largest.affectedAreaKm2} km² not in the answer`);
    if (n === 1 && !/grow|growth|new area|last 24/i.test(turn.text)) fails.push("no growth figure");
    if (n === 2) {
      const places = gt.places?.status === "ok" ? gt.places.data.slice(0, 3).map((p) => p.name) : [];
      if (places.length && !places.some((p) => turn.text.includes(p))) fails.push(`none of the nearest places (${places.join(", ")}) named`);
      if (gt.places?.status === "failed" && !/unavailable|could not|couldn't|not available/i.test(turn.text)) fails.push("places lookup failed but the answer does not say unavailable");
      if (gt.weather?.status === "ok" && !/wind/i.test(turn.text)) fails.push("no wind");
    }
    if (n === 3 && !/June|2023-06|06-0\d/i.test(turn.text)) fails.push("no dates in the development summary");
  }
  if (!gt.largest && !/replay (clock|time)|as of|not detected|nothing (has been )?detected|no incidents (have been )?detected yet/i.test(turn.text))
    fails.push("empty result without replay time / 'nothing detected yet'");
  return fails;
}

const results = [];
for (const [n, q] of QUESTIONS) {
  for (let r = 0; r < REPEAT; r++) {
    const gt = AT === "done" ? await truth() : null;
    log(`\n━━━ Q${n}${REPEAT > 1 ? ` (run ${r + 1})` : ""}: ${q}`);
    let turn;
    try {
      turn = await askOnce(q);
    } catch (e) {
      turn = { question: q, text: "", tools: [], error: String(e.message ?? e), meta: null, ms: TURN_TIMEOUT_MS };
    }
    const gtAfter = gt ?? (await truth());
    for (const c of turn.tools) {
      const o = c.output ?? {};
      const summary = o.error ? `error ${o.error}` : "count" in o ? `count=${o.count} streamTime=${o.streamTime ?? "-"}${o.emptyReason ? ` emptyReason=${o.emptyReason}` : ""}` : JSON.stringify(o).slice(0, 120);
      log(`  🔧 ${c.name}(${JSON.stringify(c.input)}) → ${summary}`);
    }
    const timing = turn.meta?.timing;
    if (timing)
      for (const s of timing.steps)
        log(
          `  step ${s.step}: ${s.ms} ms (model ${s.modelMs} ms, out ${s.outputTokens ?? "?"} tok, reasoning ${s.reasoningTokens ?? "?"} tok)` +
            (s.tools.length ? ` tools: ${s.tools.map((t) => `${t.name} ${t.ms} ms`).join(", ")}` : "")
        );
    log(`  answer: ${turn.text.trim().replace(/\n+/g, " ⏎ ")}`);
    const fails = check(n, turn, gtAfter);
    log(`  ${fails.length ? "FAIL" : "PASS"} Q${n} ${(turn.ms / 1000).toFixed(1)} s` + (timing ? ` (model ${(timing.modelMs / 1000).toFixed(1)} s, tools ${(timing.toolMs / 1000).toFixed(1)} s, reasoning ${timing.reasoningTokens} tok, ${timing.steps.length} steps)` : "") + (fails.length ? `: ${fails.join("; ")}` : ""));
    results.push({ n, question: q, ms: turn.ms, reasoningEffort: turn.meta?.reasoningEffort ?? null, timing, tools: turn.tools.map((c) => ({ name: c.name, input: c.input })), text: turn.text, fails });
  }
}

console.log("\nsummary");
for (const r of results) console.log(`  Q${r.n} ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${r.fails.length ? "FAIL" : "PASS"}  tools: ${r.tools.map((t) => t.name).join(", ") || "(none)"}  effort: ${r.reasoningEffort}`);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ host: HOST, replay: replay.id, at: AT, results }, null, 2));
process.exit(results.some((r) => r.fails.length) ? 1 : 0);
