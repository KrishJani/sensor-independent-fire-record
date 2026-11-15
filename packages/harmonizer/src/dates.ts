// UTC date helpers on 'YYYY-MM-DD' strings.

export function addDays(date: string, n: number): string {
  const t = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function* dateRange(from: string, to: string): Generator<string> {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export const yearOf = (d: string) => +d.slice(0, 4);
export const monthOf = (d: string) => +d.slice(5, 7);
export const dayOf = (d: string) => +d.slice(8, 10);

export function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
export function minDate(a: string, b: string): string {
  return a < b ? a : b;
}
