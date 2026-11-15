#!/usr/bin/env node
// Runs scripts/chat-smoke.mjs against several CHAT_MODELs and prints a scorecard.
// Each model gets its own `wrangler dev --var CHAT_MODEL:<id>` on PORT, so wrangler.jsonc
// is never edited. Uses (and bills) the logged-in Cloudflare account.
//
//   pnpm --filter api-worker compare-models
//   MODELS="@cf/a,@cf/b" RUNS=3 PORT=8790 pnpm --filter api-worker compare-models
//
// Writes full replies to OUT (default: compare-models.json in the working directory).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(here, "..");
const MODELS = (
  process.env.MODELS ?? "@cf/moonshotai/kimi-k2.6,@cf/zai-org/glm-4.7-flash,@cf/openai/gpt-oss-120b"
).split(",");
const RUNS = Number(process.env.RUNS ?? 2);
const PORT = process.env.PORT ?? "8790";
const OUT = resolve(process.env.OUT ?? "compare-models.json");

function startDev(model) {
  const child = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "--port", PORT, "--var", `CHAT_MODEL:${model}`, "--var", "ALLOWED_ORIGINS:http://localhost:5173"],
    {
      cwd,
      env: {
        ...process.env,
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: "postgres://dev:dev@localhost:5432/dev"
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    }
  );
  return new Promise((ok, fail) => {
    let log = "";
    const onData = (d) => {
      log += d;
      if (log.includes("Ready on")) ok(child);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => fail(new Error(`wrangler dev exited (${code}):\n${log.slice(-2000)}`)));
    setTimeout(() => fail(new Error("wrangler dev not ready after 90s")), 90_000);
  });
}

function stopDev(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  return new Promise((r) => setTimeout(r, 1500));
}

function runSmoke() {
  return new Promise((ok) => {
    const child = spawn("node", [resolve(here, "chat-smoke.mjs")], {
      cwd,
      env: { ...process.env, HOST: `localhost:${PORT}`, SMOKE_JSON: "1" }
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("exit", () => {
      const line = out.trim().split("\n").pop() ?? "";
      try {
        ok(JSON.parse(line));
      } catch {
        ok({ ok: false, fails: [`unparseable smoke output: ${out.slice(-300)}`], warns: [], turns: [] });
      }
    });
  });
}

const results = [];
for (const model of MODELS) {
  console.log(`\n=== ${model} ===`);
  let dev;
  try {
    dev = await startDev(model);
  } catch (err) {
    console.log(`  could not start wrangler dev: ${err.message}`);
    results.push({ model, runs: [] });
    continue;
  }
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await runSmoke();
    runs.push(r);
    const ms = r.turns.map((t) => t.ms).join("+");
    console.log(`  run ${i + 1}: ${r.ok ? "PASS" : "FAIL"} (${ms || "-"} ms)`);
    for (const f of r.fails) console.log(`    FAIL ${f}`);
    for (const w of r.warns) console.log(`    WARN ${w}`);
  }
  await stopDev(dev);
  results.push({ model, runs });
}

console.log("\n=== scorecard (fewer failures is better) ===");
const rows = results.map(({ model, runs }) => {
  const fails = runs.reduce((s, r) => s + r.fails.length, 0);
  const warns = runs.reduce((s, r) => s + r.warns.length, 0);
  const passed = runs.filter((r) => r.ok).length;
  const ms = runs.flatMap((r) => r.turns.map((t) => t.ms));
  const avgMs = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null;
  return { model, passed: `${passed}/${runs.length}`, fails, warns, avgTurnMs: avgMs };
});
console.table(rows);
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`full replies: ${OUT}`);
