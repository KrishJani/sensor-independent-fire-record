import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bbox, Satellite } from '../../../packages/harmonizer/src/index.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface Region {
  id: string;
  name: string;
  bbox: Bbox;
}

export interface RegionsConfig {
  regions: Region[];
  gridDeg: number;
  calibrationYears: [number, number];
  baselineYears: [number, number];
  alphaShrinkageK: number;
  staticMaskMinDetections: number;
  minMonthlyCellsForValidation: number;
}

export interface SensorsConfig {
  satellites: Record<Satellite, { source: string | null; nrtSource: string; start: string | null }>;
  outages: { satellite: Satellite; from: string; to: string; note?: string }[];
}

export function loadRegions(): RegionsConfig {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'config/regions.json'), 'utf8'));
}

export function loadSensors(): SensorsConfig {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'config/sensors.json'), 'utf8'));
}

export function getRegion(cfg: RegionsConfig, id: string): Region {
  const r = cfg.regions.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown region "${id}". Known: ${cfg.regions.map((x) => x.id).join(', ')}`);
  return r;
}

/** SP sources needed for the backfill. */
export const SP_SOURCES = ['MODIS_SP', 'VIIRS_SNPP_SP', 'VIIRS_NOAA20_SP', 'VIIRS_NOAA21_SP'] as const;

export function satellitesOfSource(source: string): Satellite[] {
  const s = source.toUpperCase();
  if (s.startsWith('MODIS')) return ['TERRA', 'AQUA'];
  if (s.includes('SNPP')) return ['SNPP'];
  if (s.includes('NOAA20')) return ['NOAA20'];
  if (s.includes('NOAA21')) return ['NOAA21'];
  return [];
}
