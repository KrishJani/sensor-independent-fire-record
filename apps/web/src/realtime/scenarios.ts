import type { Annotation } from './layers';
import type { Bbox } from './types';

export interface Scenario {
  id: string;
  title: string;
  blurb: string;
  /** Camera target when the scenario starts. */
  bounds: Bbox;
  /** Data window, for the chat context (`from`/`to`). */
  from: string;
  to: string;
  annotations: Annotation[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'quebec-2023-06',
    title: 'Quebec, June 2023',
    blurb: '~60,000 VIIRS detections over 10 days, played back in about 75 seconds.',
    // Quebec fire belt, extended south so New York City stays in view.
    bounds: [-80, 40.2, -60, 53],
    from: '2023-06-01',
    to: '2023-06-10',
    annotations: [{ lon: -74.006, lat: 40.7128, label: 'NYC: orange skies Jun 7' }],
  },
];

export const scenarioById = (id: string | undefined) => SCENARIOS.find((s) => s.id === id) ?? null;

/** Stream seconds per real second. 12,000 is the worker default (10 days in ~75 s). */
export type SpeedId = '6000' | '12000' | '24000' | '36000';

export const SPEEDS: { id: SpeedId; label: string }[] = [
  { id: '6000', label: '0.5×' },
  { id: '12000', label: '1×' },
  { id: '24000', label: '2×' },
  { id: '36000', label: '3×' },
];
