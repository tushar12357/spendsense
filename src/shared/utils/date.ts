// src/shared/utils/date.ts
// Timezone-aware date utilities for reporting-period calculations.
// Storage is always TIMESTAMPTZ (UTC). "Months" are calendar months in the user's IANA timezone.

export interface YearMonth {
  year: number;
  month: number; // 1-12
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, f);
  }
  return f;
}

/** True when `tz` is an IANA zone name this runtime understands. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock components of an instant in the given timezone. */
export function localParts(instant: Date, timezone: string) {
  const parts = formatterFor(timezone).formatToParts(instant);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset (ms) of `timezone` from UTC at the given instant. Positive east of Greenwich. */
function offsetAt(instant: Date, timezone: string): number {
  const p = localParts(instant, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Converts a wall-clock time in `timezone` to the UTC instant.
 * Two-pass so the offset is evaluated near the *target* instant, which keeps the
 * result correct across DST transitions (e.g. America/New_York).
 */
export function zonedToUtc(
  wall: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timezone: string,
): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0, wall.second ?? 0);
  const first = naive - offsetAt(new Date(naive), timezone);
  return new Date(naive - offsetAt(new Date(first), timezone));
}

/** First instant of the given month in the given timezone, as a UTC Date. */
export function firstOfMonth(year: number, month: number, timezone: string): Date {
  return zonedToUtc({ year, month, day: 1 }, timezone);
}

/** [start of month, start of next month) in UTC for a calendar month in `timezone`. */
export function monthBoundaries(year: number, month: number, timezone: string): { from: Date; to: Date } {
  const next = addMonths({ year, month }, 1);
  return { from: firstOfMonth(year, month, timezone), to: firstOfMonth(next.year, next.month, timezone) };
}

export function addMonths(ym: YearMonth, delta: number): YearMonth {
  const idx = ym.year * 12 + (ym.month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12 + 12) % 12 + 1 };
}

/** The current calendar month in the user's timezone. */
export function currentYearMonth(timezone: string, now: Date = new Date()): YearMonth {
  const { year, month } = localParts(now, timezone);
  return { year, month };
}

/** Local calendar date (YYYY-MM-DD) of an instant in the given timezone. */
export function toLocalDate(instant: Date, timezone: string): string {
  const { year, month, day } = localParts(instant, timezone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** First day of the month as a DATE-compatible value (budgets.period_month). */
export function toPeriodMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}

/** 'YYYY-MM' label. */
export function formatYearMonth(ym: YearMonth): string {
  return `${String(ym.year).padStart(4, '0')}-${String(ym.month).padStart(2, '0')}`;
}

/** Whole calendar months from `from` (inclusive) until `to`'s month, at least 0. */
export function monthsBetween(from: YearMonth, to: YearMonth): number {
  return Math.max(0, (to.year - from.year) * 12 + (to.month - from.month));
}
