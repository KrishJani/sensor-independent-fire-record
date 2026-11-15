// Industrial-heat / non-fire layer: the detections the harmonized calendar EXCLUDES, kept with the reason.
// Re-derived in one pass over the raw files from the region's own static_mask.csv (no model refit), so
// it always matches exactly what `run` removed:
//   type 1 → volcano · type 2 → static_source_type · type 3 → offshore            (FIRMS labels)
//   masked cell → static_source_cell | persistent_viirs_only | eog_flare_site     (static_mask.csv reason)
// Same region clip, date range, NRT skip and confidence thresholds as the fire record.
//
//   data/harmonized/<region>/industrial_heat/<year>.csv.gz   detection columns + reason
//   data/harmonized/<region>/industrial_heat/manifest.json   counts by reason, hashes

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  DETECTION_HEADER,
  HARMONIZER_VERSION,
  compareDetections,
  createFirmsLineParser,
  detectionKey,
  detectionRow,
  cellInRegion,
  toCellId,
  type Bbox,
  type Detection,
} from '../../../packages/harmonizer/src/index.ts';
import type { Region } from './config.ts';
import { contentHashOfFile, forEachLine, gzipDeterministic, listCsvFiles, writeAtomic } from './files.ts';

export type HeatReason = 'volcano' | 'static_source_type' | 'offshore' | 'static_source_cell' | 'persistent_viirs_only' | 'eog_flare_site';

export async function buildIndustrialHeat(o: {
  region: Region;
  excludeBboxes: Bbox[];
  rawDir: string;
  outDir: string; // data/harmonized/<region>
  log: (m: string) => void;
}) {
  const manifest = JSON.parse(readFileSync(join(o.outDir, 'manifest.json'), 'utf8'));
  const { from, to } = manifest.range as { from: string; to: string };
  const maskReason = new Map<number, HeatReason>();
  for (const l of readFileSync(join(o.outDir, 'static_mask.csv'), 'utf8').trim().split('\n').slice(1)) {
    const f = l.split(',');
    const r = f[4] ?? 'static_type';
    maskReason.set(+f[0], r === 'static_type' ? 'static_source_cell' : (r as HeatReason));
  }
  const inside = (d: Detection) => d.acqDate >= from && d.acqDate <= to && cellInRegion(toCellId(d.lat, d.lon), o.region.bbox, o.excludeBboxes);
  const byYear = new Map<string, Map<string, { d: Detection; reason: HeatReason }>>();
  const counts: Record<string, number> = {};
  for (const f of listCsvFiles(o.rawDir)) {
    if (/fire_nrt_/i.test(f)) continue;
    const p = createFirmsLineParser({ tier: 'SP' });
    await forEachLine(f, (line) => {
      const d = p.line(line);
      if (!d || /NRT/i.test(d.version) || !inside(d)) return;
      // Same confidence thresholds as the fire record (filter.ts): MODIS ≥ 30, VIIRS n/h.
      if (d.confidence < (d.sensor === 'MODIS' ? 30 : 60)) return;
      let reason: HeatReason | undefined =
        d.type === 1 ? 'volcano' : d.type === 2 ? 'static_source_type' : d.type === 3 ? 'offshore' : maskReason.get(toCellId(d.lat, d.lon));
      if (!reason) return; // a fire detection: it is in the calendar, not here
      const y = d.acqDate.slice(0, 4);
      const m = byYear.get(y) ?? byYear.set(y, new Map()).get(y)!;
      const k = detectionKey(d);
      if (!m.has(k)) m.set(k, { d, reason });
    });
  }
  const dir = join(o.outDir, 'industrial_heat');
  if (existsSync(dir)) for (const n of readdirSync(dir)) if (/^\d{4}\.csv\.gz$/.test(n)) unlinkSync(join(dir, n));
  const outputs: Record<string, { sha256: string; rows: number }> = {};
  for (const [y, m] of [...byYear.entries()].sort()) {
    const rows = [...m.values()].sort((a, b) => compareDetections(a.d, b.d));
    let csv = DETECTION_HEADER + ',reason\n';
    for (const { d, reason } of rows) {
      csv += detectionRow(d, HARMONIZER_VERSION).replace(/\n$/, `,${reason}\n`);
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
    const gz = gzipDeterministic(csv);
    writeAtomic(join(dir, `${y}.csv.gz`), gz);
    outputs[`${y}.csv.gz`] = { sha256: contentHashOfFile(`${y}.csv.gz`, gz), rows: rows.length };
  }
  writeAtomic(join(dir, 'manifest.json'), JSON.stringify({ harmonizer_version: HARMONIZER_VERSION, region: o.region.id, range: { from, to }, counts, outputs }, null, 2) + '\n');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  o.log(`${o.region.id}: ${total.toLocaleString()} non-fire detections → ${dir} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  return counts;
}
