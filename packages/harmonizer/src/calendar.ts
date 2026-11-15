// Year × Month calendar (harmonizer SPEC §8.1).

import { daysInMonth, monthOf, yearOf } from './dates.ts';
import type { CalendarCell, HarmonizedDay } from './types.ts';

export function buildCalendar(days: Iterable<HarmonizedDay>): CalendarCell[] {
  const cells = new Map<string, CalendarCell>();
  for (const d of days) {
    const year = yearOf(d.acqDate);
    const month = monthOf(d.acqDate);
    const key = `${year}-${month}`;
    let c = cells.get(key);
    if (!c) {
      c = {
        year,
        month,
        harmonizedCellDays: 0,
        rawDetections: 0,
        unscaledCellDays: 0,
        modisScaledCellDays: 0,
        nModisDays: 0,
        modisCellDays: 0,
        viirsCellDays: 0,
        sourceMix: 0,
        nDays: 0,
        nViirsDays: 0,
        nModisScaledDays: 0,
        nNoneDays: 0,
        peakFrpMw: null,
        peakFrpSensor: null,
        complete: false,
      };
      cells.set(key, c);
    }
    c.harmonizedCellDays += d.harmonizedCellDays;
    c.rawDetections += d.rawDetections;
    c.unscaledCellDays += d.unscaledCellDays;
    if (d.modisScaledCellDays !== null) {
      c.modisScaledCellDays += d.modisScaledCellDays;
      c.nModisDays++;
    }
    c.modisCellDays += d.modisCellDays;
    c.viirsCellDays += d.viirsCellDays;
    c.nDays++;
    if (d.basis === 'VIIRS') c.nViirsDays++;
    else if (d.basis === 'MODIS_SCALED') c.nModisScaledDays++;
    else c.nNoneDays++;
    if (d.peakFrpMw !== null && (c.peakFrpMw === null || d.peakFrpMw > c.peakFrpMw)) {
      c.peakFrpMw = d.peakFrpMw;
      c.peakFrpSensor = d.peakFrpSensor;
    }
  }
  const out = [...cells.values()];
  for (const c of out) {
    c.sourceMix = c.nDays ? c.nViirsDays / c.nDays : 0;
    c.complete = c.nDays === daysInMonth(c.year, c.month) && c.nNoneDays === 0;
  }
  return out.sort((a, b) => a.year - b.year || a.month - b.month);
}
