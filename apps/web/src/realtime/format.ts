const int = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export const fmtInt = (n: number) => int.format(n);

export function fmtKm2(n: number): string {
  return `${n >= 100 ? int.format(n) : one.format(n)} km²`;
}

export function fmtMw(n: number): string {
  if (n >= 10_000) return `${one.format(n / 1000)} GW`;
  return `${n >= 100 ? int.format(n) : one.format(n)} MW`;
}

const clockFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const hhmm = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});
const shortFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** "Tue Jun 6 2023, 18:00 UTC" */
export function fmtClock(t: number): string {
  return `${clockFmt.format(t).replace(/,(?= \d{4})/, '')}, ${hhmm.format(t)} UTC`;
}

/** "Jun 6, 18:00 UTC" */
export function fmtShort(t: number): string {
  return `${shortFmt.format(t)}, ${hhmm.format(t)} UTC`;
}

/** "3 h ago" relative to a reference time (stream time, not wall clock). */
export function fmtAgo(t: number, now: number): string {
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** UTC calendar date `YYYY-MM-DD`. */
export function isoDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}
