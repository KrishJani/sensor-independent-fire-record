// Harmonized coverage (packages/harmonizer/src/coverage.ts) bound to config/regions.json.
import { createCoverage, inUS, MIN_COVERAGE, type Bbox, type CoverageRegion } from '@repo/harmonizer';
import regionsConfig from '../../../../config/regions.json';

const { coverage: cov } = createCoverage((regionsConfig as unknown as { regions: CoverageRegion[] }).regions);

export { inUS, MIN_COVERAGE };
export const coverage = (bbox: Bbox, cells: number[] | null = null): number => cov(bbox, cells);
