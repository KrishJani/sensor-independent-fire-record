/** Calendar date in UTC, formatted `YYYY-MM-DD` (FIRMS `acq_date` convention). */
export type ISODate = string;

export interface YearMonth {
  year: number;
  /** 0–11 */
  month: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): ISODate {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function parseISODate(s: ISODate): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function makeISODate(year: number, month: number, day: number): ISODate {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

export function todayUTC(): ISODate {
  return toISODate(new Date());
}

export function addDays(s: ISODate, days: number): ISODate {
  const d = parseISODate(s);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

export function clampDate(s: ISODate, min: ISODate, max: ISODate): ISODate {
  return s < min ? min : s > max ? max : s;
}

export function monthOf(s: ISODate): YearMonth {
  const d = parseISODate(s);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

export function addMonths({ year, month }: YearMonth, n: number): YearMonth {
  const total = year * 12 + month + n;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

export function monthIndex({ year, month }: YearMonth): number {
  return year * 12 + month;
}

export function daysInMonth({ year, month }: YearMonth): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function firstWeekday({ year, month }: YearMonth): number {
  return new Date(Date.UTC(year, month, 1)).getUTCDay();
}

const longFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const monthFormat = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatLong(s: ISODate): string {
  return longFormat.format(parseISODate(s));
}

export function formatMonth(ym: YearMonth): string {
  return monthFormat.format(new Date(Date.UTC(ym.year, ym.month, 1)));
}
