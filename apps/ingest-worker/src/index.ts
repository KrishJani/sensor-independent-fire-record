// nasa-fire-ingest: cron-only worker that keeps the realtime tier (D1) current (SPEC.md).
//   every tick: NRT, whole world → D1 (recent days + catch-up of the 92-day window)
//   SP → Postgres and the D1 → Postgres handover (SPEC §3.2–3.3) run on the 24 h gate: not built yet,
//   so D1 keeps every NRT day it has loaded (nothing is deleted before it is safely in Postgres).
import { createFirms, FirmsFatal } from './firms.ts';
import { loadMasks } from './masks.ts';
import { runNrt } from './nrt.ts';

const LOCK = 'ingest:lock';
const LOCK_TTL_S = 30 * 60; // self-heals after a crash; longer than a run's time budget
const RUN_BUDGET_MS = 12 * 60_000; // cron wall-clock limit is 15 min

const log = (o: object) => console.log(JSON.stringify(o));

async function bump(env: Env, key: string) {
  const v = Number((await env.INGEST_STATE.get(key)) ?? '0');
  await env.INGEST_STATE.put(key, String((Number.isFinite(v) ? v : 0) + 1));
}

export async function runTick(env: Env): Promise<void> {
  const started = Date.now();
  const lock = await env.INGEST_STATE.get(LOCK);
  if (lock) { log({ job: 'tick', msg: 'another run holds the lock', lock }); return; }
  const runId = crypto.randomUUID();
  await env.INGEST_STATE.put(LOCK, JSON.stringify({ runId, startedAt: new Date().toISOString() }), { expirationTtl: LOCK_TTL_S });
  try {
    try {
      const firms = createFirms(env.FIRMS_MAP_KEY, Number(env.FIRMS_MAX_TX_PER_RUN) || 1500, log);
      const masks = await loadMasks(env, log);
      const s = await runNrt(env, firms, masks, log, started + RUN_BUDGET_MS);
      if (s.detectionsWritten || s.cellDaysWritten || s.cellDaysDeleted) await bump(env, 'data:version:realtime');
      await env.INGEST_STATE.put('ingest:nrt:last_success_at', new Date().toISOString());
      log({ job: 'nrt', msg: 'done', runId, ...s, ms: Date.now() - started });
    } catch (e) {
      log({ job: 'nrt', level: e instanceof FirmsFatal ? 'fatal' : 'error', runId, err: String(e), stack: (e as Error).stack });
    }
    // SP + handover (24 h gate) go here — SPEC §3.2–3.3.
  } finally {
    await env.INGEST_STATE.delete(LOCK);
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runTick(env));
  },
  // No public routes (SPEC): everything happens on the cron.
  async fetch() {
    return new Response('nasa-fire-ingest: cron only', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
