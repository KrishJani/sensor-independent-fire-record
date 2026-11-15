// Minimal NASA FIRMS API client for Node: throttling, retries, fatal-error detection.
// The ingest worker gets its own Workers-flavoured copy in Stage 4.

const BASE = 'https://firms.modaps.eosdis.nasa.gov';

export class FirmsFatalError extends Error {}

export interface FirmsClientOptions {
  mapKey: string;
  minIntervalMs?: number; // spacing between calls (rate limit: 5000 tx / 10 min / key)
  maxTransactions?: number;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Budget check: pause when the key has used this share of its rolling 10-minute limit. */
const HIGH_WATER = 0.85;
const CHECK_EVERY = 20; // requests between proactive status checks
const MAX_LIMIT_WAIT_MS = 30 * 60_000;

export function createFirmsClient(opts: FirmsClientOptions) {
  if (!opts.mapKey) throw new FirmsFatalError('FIRMS_MAP_KEY is not set (get one at https://firms.modaps.eosdis.nasa.gov/api/map_key/)');
  const minInterval = opts.minIntervalMs ?? 400;
  const log = opts.log ?? ((m: string) => console.error(m));
  let last = 0;
  let used = 0;
  let sinceCheck = 0;
  const redact = (u: string) => u.replace(opts.mapKey, '<MAP_KEY>');

  /**
   * FIRMS key usage. An area request costs several transactions (≈10 for a 5-day California
   * request), so request counts alone cannot pace us. This endpoint is not itself metered.
   */
  async function status(): Promise<{ limit: number; current: number } | null> {
    try {
      const r = await fetch(`${BASE}/mapserver/mapkey_status/?MAP_KEY=${opts.mapKey}`, { signal: AbortSignal.timeout(30_000) });
      const j = (await r.json()) as { transaction_limit?: number; current_transactions?: number };
      if (typeof j.transaction_limit !== 'number' || typeof j.current_transactions !== 'number') return null;
      return { limit: j.transaction_limit, current: j.current_transactions };
    } catch {
      return null;
    }
  }

  /** Wait (in 60 s steps) until usage drops below `target` × limit. Returns false if it never does. */
  async function waitForBudget(target: number, reason: string): Promise<boolean> {
    const t0 = Date.now();
    for (;;) {
      const st = await status();
      if (!st) return false;
      if (st.current < st.limit * target) return true;
      if (Date.now() - t0 > MAX_LIMIT_WAIT_MS) return false;
      log(`${reason}: ${st.current}/${st.limit} transactions used in the last 10 min — waiting 60 s`);
      await sleep(60_000);
    }
  }

  async function get(path: string): Promise<string> {
    const url = `${BASE}${path.replace('{KEY}', opts.mapKey)}`;
    for (let attempt = 0; ; attempt++) {
      if (opts.maxTransactions && used >= opts.maxTransactions) throw new FirmsFatalError(`transaction budget ${opts.maxTransactions} reached`);
      if (++sinceCheck >= CHECK_EVERY) {
        sinceCheck = 0;
        await waitForBudget(HIGH_WATER, 'pacing');
      }
      const wait = last + minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      used++;
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      } catch (e) {
        if (attempt >= 3) throw new Error(`network error after retries: ${redact(url)}: ${(e as Error).message}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const body = await res.text();
      if (/Invalid MAP_KEY|Exceeding allowed transaction limit/i.test(body)) {
        // FIRMS answers "Invalid MAP_KEY" when a valid key is over its 10-minute limit.
        // Ask the status endpoint which it is: over the limit → wait and retry; otherwise fatal.
        const st = await status();
        if (st && st.current >= st.limit * HIGH_WATER) {
          if (await waitForBudget(0.5, 'transaction limit reached')) {
            attempt = -1; // not a real failure; retry from scratch
            continue;
          }
          throw new FirmsFatalError('FIRMS: transaction limit did not reset within 30 minutes — re-run later');
        }
        throw new FirmsFatalError(`FIRMS: ${body.trim().slice(0, 80)}${st ? ` (key status ${st.current}/${st.limit})` : ''}`);
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= 3) throw new Error(`FIRMS HTTP ${res.status} after retries: ${redact(url)}`);
        log(`FIRMS HTTP ${res.status}, retry ${attempt + 1} in ${2 ** attempt}s`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`FIRMS HTTP ${res.status}: ${redact(url)}: ${body.slice(0, 200)}`);
      if (!/^\s*[a-z_]+,/i.test(body) && body.trim() !== '') {
        throw new Error(`FIRMS returned a non-CSV body for ${redact(url)}: ${body.slice(0, 200)}`);
      }
      return body;
    }
  }

  return {
    /** Requests sent by this client (each costs several FIRMS transactions). */
    get transactionsUsed() {
      return used;
    },
    status,
    /** Rows with acq_date in [date, date + dayRange − 1]. */
    area(source: string, bbox: number[], dayRange: number, date: string) {
      return get(`/api/area/csv/{KEY}/${source}/${bbox.join(',')}/${dayRange}/${date}`);
    },
    availability() {
      return get(`/api/data_availability/csv/{KEY}/ALL`);
    },
  };
}

/** Parse `data_id,min_date,max_date` CSV from the availability endpoint. */
export function parseAvailability(csv: string): Map<string, { min: string; max: string }> {
  const out = new Map<string, { min: string; max: string }>();
  const lines = csv.trim().split(/\r?\n/);
  const head = lines.shift()?.split(',').map((h) => h.trim().toLowerCase()) ?? [];
  const iId = head.indexOf('data_id');
  const iMin = head.indexOf('min_date');
  const iMax = head.indexOf('max_date');
  if (iId < 0 || iMin < 0 || iMax < 0) throw new Error(`unexpected availability header: ${head.join(',')}`);
  for (const l of lines) {
    const f = l.split(',');
    if (f[iId]) out.set(f[iId].trim(), { min: f[iMin].trim(), max: f[iMax].trim() });
  }
  return out;
}
