// After a successful archival load, bump `data:version:archival` in the FIRMS_INGEST_STATE KV namespace.
// The api-worker puts this value in every cache key (apps/api-worker/src/lib/cache.ts), so a new version
// makes all cached archival responses miss at once: no purge needed, no stale data for up to a day.
// The namespace comes from apps/api-worker/wrangler.jsonc, so the write targets the namespace the API reads.
// The account is account_id in that file if present, else CLOUDFLARE_ACCOUNT_ID, else wrangler's logged-in account.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './config.ts';

export const ARCHIVAL_VERSION_KEY = 'data:version:archival';

function apiWorkerConfig(): { accountId: string | undefined; namespaceId: string } {
  const raw = readFileSync(join(REPO_ROOT, 'apps/api-worker/wrangler.jsonc'), 'utf8');
  // JSONC: drop // and /* */ comments (outside strings) and trailing commas.
  const json = raw.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '').replace(/,(\s*[}\]])/g, '$1');
  const c = JSON.parse(json) as { account_id?: string; kv_namespaces?: { binding: string; id: string }[] };
  const ns = c.kv_namespaces?.find((k) => k.binding === 'INGEST_STATE');
  if (!ns) throw new Error('apps/api-worker/wrangler.jsonc: INGEST_STATE KV binding missing');
  return { accountId: c.account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID, namespaceId: ns.id };
}

/** A new, sortable version per load: ISO time plus what was loaded (for humans reading KV). */
export function newArchivalVersion(what: string): string {
  return `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} ${what}`;
}

/** Returns true when KV was updated; on failure logs the exact command to run by hand and returns false. */
export function bumpArchivalVersion(version: string, log: (m: string) => void): boolean {
  const { accountId, namespaceId } = apiWorkerConfig();
  const args = ['--prefix', join(REPO_ROOT, 'apps/api-worker'), 'wrangler', 'kv', 'key', 'put', ARCHIVAL_VERSION_KEY, version, '--namespace-id', namespaceId, '--remote'];
  const env = accountId ? { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId } : process.env;
  const r = spawnSync('npx', args, { encoding: 'utf8', env, timeout: 60_000 });
  if (r.status === 0) {
    log(`KV ${ARCHIVAL_VERSION_KEY} = "${version}" (namespace ${namespaceId}): API caches for archival data are now invalidated`);
    return true;
  }
  const why = (r.stderr || r.stdout || String(r.error ?? '')).trim().split('\n').filter(Boolean).slice(-2).join(' / ');
  log(`WARNING: data loaded, but the KV cache version was NOT bumped (${why || `exit ${r.status}`}).`);
  log(`  Run: ${accountId ? `CLOUDFLARE_ACCOUNT_ID=${accountId} ` : ''}npx wrangler kv key put "${ARCHIVAL_VERSION_KEY}" "${version}" --namespace-id ${namespaceId} --remote`);
  return false;
}
