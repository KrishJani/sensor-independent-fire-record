// Check that a region group tiles its country file: every kept detection in exactly one region.
// Usage: node scripts/backfill/experiments/region-coverage.ts <group> <rawDir>
import { createFirmsLineParser, keepDetection } from '../../../packages/harmonizer/src/index.ts';
import { excludedBboxes, loadRegions, regionContains } from '../src/config.ts';
import { forEachLine, listCsvFiles } from '../src/files.ts';

const [group = 'us', rawDir = 'data/raw/us'] = process.argv.slice(2);
const cfg = loadRegions();
const regions = cfg.regions.filter((r) => r.group === group).map((r) => ({ r, ex: excludedBboxes(cfg, r) }));
const counts = new Map<string, number>();
let none = 0, multi = 0, total = 0;
const strays = new Map<string, number>();
for (const f of listCsvFiles(rawDir)) {
  const p = createFirmsLineParser({ tier: 'SP' });
  await forEachLine(f, (line) => {
    const d = p.line(line);
    if (!d || !keepDetection(d)) return;
    total++;
    const hits = regions.filter(({ r, ex }) => regionContains(r, ex, d.lat, d.lon));
    if (hits.length === 0) { none++; const k = `${Math.round(d.lat)},${Math.round(d.lon)}`; strays.set(k, (strays.get(k) ?? 0) + 1); }
    else if (hits.length > 1) multi++;
    else counts.set(hits[0].r.id, (counts.get(hits[0].r.id) ?? 0) + 1);
  });
}
console.log(`${total.toLocaleString()} kept US detections; in no region: ${none} (${((none / total) * 100).toFixed(3)}%); in >1 region: ${multi}`);
for (const { r } of regions) console.log(`  ${r.id.padEnd(18)} ${(counts.get(r.id) ?? 0).toLocaleString().padStart(11)}  ${(((counts.get(r.id) ?? 0) / total) * 100).toFixed(1)}%`);
if (none) console.log('  stray clusters (lat,lon → n):', [...strays].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}→${n}`).join('  '));
