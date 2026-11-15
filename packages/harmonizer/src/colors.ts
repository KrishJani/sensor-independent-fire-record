// Shared color classes (harmonizer SPEC §8.3) so web and exports agree.

import type { AnomalyClass } from './anomalies.ts';
import { quantileSorted } from './calibrate.ts';

/** Quantile class breaks (n−1 interior breaks) for a sequential ramp. Zeros are excluded. */
export function countClasses(values: number[], n = 7): number[] {
  const xs = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!xs.length) return [];
  const out: number[] = [];
  for (let i = 1; i < n; i++) out.push(quantileSorted(xs, i / n));
  return [...new Set(out)];
}

// ColorBrewer PuOr (7), orange = more burning than usual.
const PUOR: Record<AnomalyClass, string> = {
  record_high: '#b35806',
  much_above: '#f1a340',
  above: '#fee0b6',
  normal: '#f7f7f7',
  below: '#d8daeb',
  much_below: '#998ec3',
  record_low: '#542788',
};

export function anomalyColor(cls: AnomalyClass): string {
  return PUOR[cls];
}
