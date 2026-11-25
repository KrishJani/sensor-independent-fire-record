// Archival map showcase periods (docs/issues/archival-showcase-data.md, Option A). Precomputed files in R2
// (SHOWCASE bucket), built by scripts/showcase/build.mjs. Used only while the detailed archive (cell_days) is not loaded.

export interface ShowcasePeriod {
  id: string;
  label: string;
  from: string;
  to: string;
  bbox: [number, number, number, number];
  /** true: California cells weighted like the calendar. false: raw detections only (outside the US archive). */
  harmonized: boolean;
  /** Shown on the map. */
  note: string;
}

export const SHOWCASE_PERIODS: ShowcasePeriod[] = [
  {
    id: "california-2020-08",
    label: "California, Aug–Sep 2020",
    from: "2020-08-01",
    to: "2020-09-30",
    bbox: [-124.5, 32.5, -114, 42.1],
    harmonized: true,
    note: "Showcase period: harmonized active cells, within 1% of the calendar."
  },
  {
    id: "quebec-2023-06",
    label: "Quebec, 1–10 June 2023",
    from: "2023-06-01",
    to: "2023-06-10",
    bbox: [-80, 45, -60, 53],
    harmonized: false,
    note: "Raw VIIRS detections (outside the US harmonized archive)"
  }
];

export const overlapsPeriod = (p: ShowcasePeriod, from: string, to: string, bbox: number[]) =>
  from <= p.to && to >= p.from && bbox[0] < p.bbox[2] && bbox[2] > p.bbox[0] && bbox[1] < p.bbox[3] && bbox[3] > p.bbox[1];
