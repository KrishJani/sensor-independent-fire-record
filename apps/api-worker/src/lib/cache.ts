import type { Ctx } from './db.ts';
// Cache API keyed by the normalized request + a KV data version, so a new ingest invalidates without a purge.
const memo = new Map<string, { v: string; at: number }>();

export async function dataVersion(env: Env, tier: 'archival' | 'realtime'): Promise<string> {
  const k = `data:version:${tier}`;
  const m = memo.get(k);
  if (m && Date.now() - m.at < 60_000) return m.v;
  const v = (await env.INGEST_STATE.get(k)) ?? '0';
  memo.set(k, { v, at: Date.now() });
  return v;
}

async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Run `fn` unless a cached response exists for (key, version). JSON responses only. */
export async function cachedJson(ctx: Ctx, key: string, version: string, ttlSeconds: number, fn: () => Promise<unknown>, headers: Record<string, string> = {}): Promise<Response> {
  const url = `https://cache.internal/${await sha256(`${key}|v${version}`)}`;
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(url);
  if (hit) return new Response(hit.body, { status: hit.status, headers: { ...Object.fromEntries(hit.headers), 'x-cache': 'HIT' } });
  const body = JSON.stringify(await fn());
  const res = new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${ttlSeconds}`, 'x-data-version': version, ...headers } });
  ctx.waitUntil(cache.put(url, res.clone()));
  return new Response(body, { headers: { ...Object.fromEntries(res.headers), 'x-cache': 'MISS' } });
}
