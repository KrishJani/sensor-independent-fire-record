// FIRMS API client for the worker (SPEC §5): live budget from /mapserver/mapkey_status, ≥ 150 ms spacing,
// retries on 429/5xx (1 s, 2 s, 4 s), and a clear split between "over the 10-minute limit" (stop this run,
// the next tick continues) and a genuinely bad key (fatal).
const BASE = 'https://firms.modaps.eosdis.nasa.gov';

export class FirmsBudgetExhausted extends Error {}
export class FirmsFatal extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FirmsStatus { limit: number; used: number }

export function createFirms(key: string, maxTxPerRun: number, log: (o: object) => void) {
  if (!key) throw new FirmsFatal('FIRMS_MAP_KEY is not set (wrangler secret put FIRMS_MAP_KEY)');
  let startUsed: number | null = null;
  let last = 0;

  async function status(): Promise<FirmsStatus> {
    const r = await fetch(`${BASE}/mapserver/mapkey_status/?MAP_KEY=${key}`, { signal: AbortSignal.timeout(30_000) });
    const j = (await r.json()) as { transaction_limit?: number; current_transactions?: number };
    if (j.transaction_limit == null) throw new FirmsFatal('FIRMS mapkey_status did not recognise the key');
    return { limit: j.transaction_limit, used: j.current_transactions ?? 0 };
  }

  /** Throws FirmsBudgetExhausted when this run's share or the key's 10-minute window is used up. */
  async function ensureBudget(reserve: number) {
    const s = await status();
    if (startUsed === null) startUsed = s.used;
    const spentThisRun = Math.max(0, s.used - startUsed);
    if (spentThisRun + reserve > maxTxPerRun) throw new FirmsBudgetExhausted(`run budget ${maxTxPerRun} used (${spentThisRun})`);
    if (s.used + reserve > s.limit) throw new FirmsBudgetExhausted(`key window ${s.used}/${s.limit} transactions`);
  }

  async function get(path: string): Promise<string> {
    const url = `${BASE}${path.replace('{KEY}', key)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = last + 150 - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      } catch (e) {
        log({ job: 'firms', level: 'warn', msg: `network error, retry ${attempt + 1}`, err: String(e) });
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const body = await res.text();
      if (/Invalid MAP_KEY|Exceeding allowed transaction limit/i.test(body)) {
        // FIRMS answers "Invalid MAP_KEY" when a VALID key is over its limit: ask which it is.
        const s = await status().catch(() => null);
        if (s && s.used >= s.limit * 0.9) throw new FirmsBudgetExhausted(`key over its limit (${s.used}/${s.limit})`);
        throw new FirmsFatal('FIRMS rejected the MAP_KEY');
      }
      if (res.status === 429 || res.status >= 500) {
        log({ job: 'firms', level: 'warn', msg: `HTTP ${res.status}, retry ${attempt + 1}` });
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`FIRMS HTTP ${res.status}: ${body.slice(0, 200)}`);
      return body;
    }
    throw new Error(`FIRMS request failed after 3 tries: ${path.split('/').slice(0, 4).join('/')}`);
  }

  return {
    status,
    ensureBudget,
    /** NRT for the whole world: the last `days` days, or `days` days starting at `date`. */
    areaWorld: (source: string, days: number, date?: string) => get(`/api/area/csv/{KEY}/${source}/world/${days}${date ? `/${date}` : ''}`),
    /** source → { min, max } dates FIRMS currently serves. */
    async availability(): Promise<Map<string, { min: string; max: string }>> {
      const csv = await get('/api/data_availability/csv/{KEY}/ALL');
      const out = new Map<string, { min: string; max: string }>();
      for (const l of csv.trim().split('\n').slice(1)) {
        const [id, min, max] = l.split(',');
        if (id && min && max) out.set(id.trim(), { min: min.trim(), max: max.trim() });
      }
      return out;
    },
  };
}
