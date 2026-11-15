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

export function createFirmsClient(opts: FirmsClientOptions) {
  if (!opts.mapKey) throw new FirmsFatalError('FIRMS_MAP_KEY is not set (get one at https://firms.modaps.eosdis.nasa.gov/api/map_key/)');
  const minInterval = opts.minIntervalMs ?? 400;
  const log = opts.log ?? ((m: string) => console.error(m));
  let last = 0;
  let used = 0;
  const redact = (u: string) => u.replace(opts.mapKey, '<MAP_KEY>');

  async function get(path: string): Promise<string> {
    const url = `${BASE}${path.replace('{KEY}', opts.mapKey)}`;
    for (let attempt = 0; ; attempt++) {
      if (opts.maxTransactions && used >= opts.maxTransactions) throw new FirmsFatalError(`transaction budget ${opts.maxTransactions} reached`);
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
      if (/Invalid MAP_KEY/i.test(body)) throw new FirmsFatalError('FIRMS: Invalid MAP_KEY');
      if (/Exceeding allowed transaction limit/i.test(body)) throw new FirmsFatalError('FIRMS: Exceeding allowed transaction limit — wait 10 minutes and resume');
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
    get transactionsUsed() {
      return used;
    },
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
