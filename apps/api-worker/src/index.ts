// nasa-fire-api: archival API (PlanetScale via Hyperdrive), realtime reads (D1), chat (FireCopilotAgent).
// Spec: apps/api-worker/SPEC.md. Harmonization math: @repo/harmonizer.
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { cachedJson, dataVersion } from './lib/cache.ts';
import { closeDbs } from './lib/db.ts';
import { ApiError, toHttp } from './lib/http.ts';
import { calendar, calendarCsv, type CalendarRequest } from './routes/calendar.ts';
import { health, meta } from './routes/meta.ts';
import { prone, proneSummary } from './routes/prone.ts';
import { spots } from './routes/spots.ts';
import { realtimeSpots } from './routes/realtime.ts';

const app = new Hono<{ Bindings: Env }>();
const DAY = 86400;

// Close per-request Postgres clients once the handler is done (also on errors).
app.use('/api/*', async (c, next) => {
  try { await next(); } finally { closeDbs(c.executionCtx); }
});
app.use('/api/*', async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return cors({ origin: (o) => (allowed.includes('*') || allowed.includes(o) ? o : null), allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 86400 })(c, next);
});
app.onError((err, c) => {
  const { status, body } = toHttp(err);
  return c.json(body, status as 400);
});

app.get('/api/health', async (c) => c.json(await health(c.env, c.executionCtx)));

app.get('/api/meta', async (c) => {
  const v = `${await dataVersion(c.env, 'archival')}.${await dataVersion(c.env, 'realtime')}`;
  return cachedJson(c.executionCtx, 'meta', v, 60, () => meta(c.env, c.executionCtx));
});

// Realtime tier (D1): 15-min TTL, keyed by data:version:realtime (bumped by the ingest worker).
app.get('/api/realtime/spots', async (c) => {
  const q = new URL(c.req.url).searchParams;
  const key = `rt-spots|${[...q.entries()].sort().map(([k, v]) => `${k}=${v}`).join('&')}`;
  return cachedJson(c.executionCtx, key, await dataVersion(c.env, 'realtime'), 900, () => realtimeSpots(c.env, q));
});

app.get('/api/archival/spots', async (c) => {
  const q = new URL(c.req.url).searchParams;
  const key = `spots|${[...q.entries()].sort().map(([k, v]) => `${k}=${v}`).join('&')}`;
  return cachedJson(c.executionCtx, key, await dataVersion(c.env, 'archival'), DAY, () => spots(c.env, c.executionCtx, q));
});

app.post('/api/calendar', async (c) => {
  let body: CalendarRequest & { mode?: string };
  try { body = await c.req.json(); } catch { throw new ApiError(400, 'body_invalid', 'body must be JSON'); }
  if (body.mode && body.mode !== 'archival') throw new ApiError(400, 'mode_unsupported', 'only mode "archival" is served here so far');
  return cachedJson(c.executionCtx, `calendar|${JSON.stringify(body)}`, await dataVersion(c.env, 'archival'), DAY, () => calendar(c.env, c.executionCtx, body));
});

app.get('/api/export/calendar.csv', async (c) => {
  const q = new URL(c.req.url).searchParams;
  const bbox = q.get('bbox')?.split(',').map(Number) as CalendarRequest['bbox'];
  const req: CalendarRequest = { scope: q.get('scope') ?? undefined, bbox: bbox ?? null, from: q.get('from') ?? undefined, to: q.get('to') ?? undefined };
  const body = await calendar(c.env, c.executionCtx, req);
  const name = `calendar_${req.scope ?? 'aoi'}_${body.range.from}_${body.range.to}.csv`;
  return new Response(calendarCsv(body), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` } });
});

app.get('/api/prone', async (c) => {
  const q = new URL(c.req.url).searchParams;
  return cachedJson(c.executionCtx, `prone|${q.toString()}`, await dataVersion(c.env, 'archival'), DAY, () => prone(c.env, c.executionCtx, q));
});
app.get('/api/prone/summary', async (c) => {
  const q = new URL(c.req.url).searchParams;
  return cachedJson(c.executionCtx, `prone-summary|${q.toString()}`, await dataVersion(c.env, 'archival'), DAY, () => proneSummary(c.env, c.executionCtx, q));
});

app.notFound((c) => c.json({ error: { code: 'not_found', message: `no route ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404));

export default app;

/** Chat copilot (apps/api-worker/SPEC.md §4). Placeholder so the Durable Object binding deploys; the agent is built separately. */
export class FireCopilotAgent extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return Response.json({ error: { code: 'not_implemented', message: 'The chat copilot is not deployed yet.' } }, { status: 501 });
  }
}
