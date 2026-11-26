// Harmonized coverage bound to config/regions.json: the same rule as the api-worker calendar's outside_regions.
import { createCoverage, MIN_COVERAGE, type CoverageRegion } from '@repo/harmonizer';
import regionsConfig from '../../../../config/regions.json';

const { coverage } = createCoverage((regionsConfig as unknown as { regions: CoverageRegion[] }).regions);

/** True when most of the view is outside the US harmonized archive (no calendar exists for it). */
export const viewOutsideArchive = (bbox: [number, number, number, number]): boolean => coverage(bbox) < MIN_COVERAGE;
