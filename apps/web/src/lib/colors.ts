/**
 * The one sequential fire ramp used everywhere (realtime, archival, calendar, legends):
 * ColorBrewer YlOrRd, low → high, starting at a yellow that still reads on light basemaps.
 */
export const YLORRD = ['#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'] as const;
/** Five-step subset for short legends and stop lists. */
export const YLORRD5 = ['#fed976', '#fd8d3c', '#fc4e2a', '#e31a1c', '#800026'] as const;

/**
 * "vs normal" (ratio to the baseline median): below normal is a muted blue-grey,
 * near normal neutral, above normal runs yellow → red.
 */
export const DIVERGING = [
  { max: 0.5, color: '#6b7f99', label: 'Much less' },
  { max: 0.8, color: '#a3b1c2', label: 'Less' },
  { max: 1.25, color: '#d9d9d6', label: 'Normal' },
  { max: 2, color: '#fed976', label: 'More' },
  { max: 4, color: '#fd8d3c', label: 'Much more' },
  { max: Infinity, color: '#e31a1c', label: 'Far more' },
] as const;

export const divergingColor = (ratioToMedian: number) => DIVERGING.find((d) => ratioToMedian < d.max)!.color;
