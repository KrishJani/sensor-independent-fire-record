// Resumable Area-API download of SP data in 5-day chunks:
//   data/raw/<region>/api/<SOURCE>/<YYYY-MM-DD>_<n>d.csv
// An empty (header-only) chunk is still written: it proves the dates were requested and
// returned no fires, which is what makes them "available" days rather than gaps.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addDays } from '../../../packages/harmonizer/src/index.ts';
import { loadSensors, satellitesOfSource, type Region } from './config.ts';
import { writeAtomic } from './files.ts';
import { createFirmsClient, FirmsFatalError, parseAvailability } from './firms.ts';

export interface DownloadOptions {
  region: Region;
  from: string;
  to: string;
  sources: string[];
  rawDir: string; // data/raw/<region>
  availabilityPath: string; // data/raw/availability.csv
  mapKey: string;
  dayRange?: number;
  minIntervalMs?: number;
  maxTransactions?: number;
  log: (m: string) => void;
}

export async function fetchAvailability(mapKey: string, path: string, log: (m: string) => void) {
  const client = createFirmsClient({ mapKey, log });
  const csv = await client.availability();
  writeAtomic(path, csv);
  log(`wrote ${path}`);
  return parseAvailability(csv);
}

export async function download(o: DownloadOptions) {
  const dayRange = o.dayRange ?? 5;
  const sensors = loadSensors();
  const client = createFirmsClient({ mapKey: o.mapKey, minIntervalMs: o.minIntervalMs, maxTransactions: o.maxTransactions, log: o.log });

  // Never request beyond the published SP range: an empty chunk past max_date would be
  // recorded as "available, no fires" and silently zero those days.
  const avail = existsSync(o.availabilityPath)
    ? parseAvailability(readFileSync(o.availabilityPath, 'utf8'))
    : await fetchAvailability(o.mapKey, o.availabilityPath, o.log);

  let fetched = 0;
  let skipped = 0;
  for (const source of o.sources) {
    const a = avail.get(source);
    if (!a) throw new FirmsFatalError(`${source} not listed by the FIRMS availability API`);
    const starts = satellitesOfSource(source).map((s) => sensors.satellites[s].start ?? a.min);
    const start = [o.from, a.min, starts.sort()[0]].sort().at(-1)!;
    const end = [o.to, a.max].sort()[0];
    o.log(`${source}: ${start} → ${end} (published ${a.min} → ${a.max})`);
    for (let d = start; d <= end; d = addDays(d, dayRange)) {
      const lastDay = [addDays(d, dayRange - 1), end].sort()[0];
      const n = Math.round((Date.parse(lastDay) - Date.parse(d)) / 86400000) + 1;
      const path = join(o.rawDir, 'api', source, `${d}_${n}d.csv`);
      if (existsSync(path)) {
        skipped++;
        continue;
      }
      const body = await client.area(source, o.region.bbox, n, d);
      // Guard the API's date semantics: every row must fall inside the requested window.
      const lines = body.split('\n');
      const iDate = (lines[0] ?? '').split(',').indexOf('acq_date');
      const dates = new Set(iDate < 0 ? [] : lines.slice(1).map((l) => l.split(',')[iDate]).filter(Boolean));
      const outside = [...dates].filter((x) => x < d || x > lastDay);
      if (outside.length) {
        throw new FirmsFatalError(`${source} ${d}/${n}d returned dates outside [${d}, ${lastDay}]: ${outside.slice(0, 3).join(', ')}`);
      }
      writeAtomic(path, body.endsWith('\n') || body === '' ? body : body + '\n');
      fetched++;
      if (fetched % 50 === 0) o.log(`  ${source} … ${d} (${fetched} fetched, ${client.transactionsUsed} requests)`);
    }
  }
  o.log(`download done: ${fetched} chunks fetched, ${skipped} already present, ${client.transactionsUsed} requests`);
}
