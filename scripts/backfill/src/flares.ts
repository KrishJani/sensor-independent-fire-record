// Known gas-flare cells from an independent inventory: EOG / Payne Institute (Colorado School of Mines)
// VIIRS Nightfire upstream gas-flaring volumes, release MYC25Q4 v1.0 (2012–2025),
// doi:10.5281/zenodo.23091822, CC BY-NC 4.0. Built from VIIRS Nightfire (night-time M-band), a product
// independent of the FIRMS detections used for calibration and validation.
//
// Rule (fixed before evaluation, docs/HARMONIZATION.md §4.4): a 0.05° cell is a known flare cell if an
// inventory site that was active (bcm > 0) in any year lies within ±bufferDeg of it (default 0.01° ≈ 1 km).

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { cellCenter, fmt, toCellId } from '../../../packages/harmonizer/src/index.ts';
import { writeAtomic } from './files.ts';

export const EOG_CITATION =
  'Zhizhin, M.; Ghosh, T.; Gleason, G.; Elvidge, C. D.; Bazilian, M. (2026). VIIRS Nightfire upstream gas-flaring volumes, 2012–2025 (MYC25Q4), version 1.0. Zenodo. doi:10.5281/zenodo.23091822. License CC BY-NC 4.0.';

export async function buildFlareCells(o: { inventory: string; out: string; bufferDeg: number; log: (m: string) => void }) {
  const rl = createInterface({ input: createReadStream(o.inventory), crlfDelay: Infinity });
  let header: string[] | null = null;
  const sites = new Map<string, { lat: number; lon: number; country: string; years: Set<number>; bcm: number }>();
  for await (const line of rl) {
    const f = line.split(',');
    if (!header) { header = f; continue; }
    const g = (k: string) => f[header!.indexOf(k)];
    const bcm = +g('bcm');
    if (!(bcm > 0)) continue; // active years only
    const id = g('flare_id');
    const s = sites.get(id) ?? sites.set(id, { lat: +g('lat'), lon: +g('lon'), country: g('country_iso'), years: new Set(), bcm: 0 }).get(id)!;
    s.years.add(+g('year'));
    s.bcm += bcm;
  }
  const cells = new Map<number, { sites: number; countries: Set<string>; first: number; last: number; bcm: number }>();
  const d = o.bufferDeg;
  for (const s of sites.values()) {
    const ids = new Set<number>();
    for (const dy of [-d, 0, d]) for (const dx of [-d, 0, d]) ids.add(toCellId(s.lat + dy, s.lon + dx));
    for (const c of ids) {
      const e = cells.get(c) ?? cells.set(c, { sites: 0, countries: new Set(), first: 9999, last: 0, bcm: 0 }).get(c)!;
      e.sites++;
      e.countries.add(s.country);
      e.first = Math.min(e.first, ...s.years);
      e.last = Math.max(e.last, ...s.years);
      e.bcm += s.bcm;
    }
  }
  let csv = `# Derived from: ${EOG_CITATION}\n# Rule: 0.05° cells within ±${d}° of an EOG upstream flare site with bcm > 0 in any year 2012–2025.\n`;
  csv += 'cell_id,grid_lat,grid_lon,n_sites,countries,first_active_year,last_active_year,total_bcm\n';
  for (const [c, e] of [...cells.entries()].sort((a, b) => a[0] - b[0])) {
    const { lat, lon } = cellCenter(c);
    csv += `${c},${fmt(lat, 4)},${fmt(lon, 4)},${e.sites},${[...e.countries].sort().join('|')},${e.first},${e.last},${fmt(e.bcm, 6)}\n`;
  }
  writeAtomic(o.out, csv);
  o.log(`${sites.size} active flare sites → ${cells.size} cells → ${o.out}`);
  return { sites: sites.size, cells: cells.size };
}

/** Read the committed cell list (comment lines start with #). */
export async function loadFlareCells(path: string): Promise<Set<number>> {
  const out = new Set<number>();
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line.startsWith('#') || line.startsWith('cell_id')) continue;
    out.add(+line.slice(0, line.indexOf(',')));
  }
  return out;
}
