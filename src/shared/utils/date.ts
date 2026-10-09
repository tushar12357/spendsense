// src/shared/utils/date.ts
// Timezone-aware date utilities for monthly boundary calculations.
// All storage is in TIMESTAMPTZ (UTC). Month boundaries are computed in user's IANA timezone.

/**
 * Returns the first instant of the given month in the given timezone as a UTC Date.
 * e.g. firstOfMonth(2024, 2, 'Asia/Kolkata') → 2024-01-31T18:30:00Z (UTC equiv of IST midnight)
 */
export function firstOfMonth(year: number, month: number, timezone: string): Date {
  // Build a local-time string in the target timezone and parse via Intl
  const localIso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01T00:00:00`;
  return zonedToUtc(localIso, timezone);
}

/**
 * Converts an ISO local datetime string (no timezone suffix) interpreted in the given
 * IANA timezone to a UTC Date.
 */
export function zonedToUtc(localIso: string, timezone: string): Date {
  // We use a trick: format a known UTC epoch in the target timezone to find the offset,
  // then apply it to the given local time.
  // This is not a full TZDB implementation but sufficient for IST (fixed +5:30).
  // For production, replace with @date-fns/tz or Luxon if dynamic DST zones are needed.

  // Parse the local ISO string as UTC first
  const utcAssumed = new Date(`${localIso}Z`);

  // Format this UTC instant in the target timezone to read the displayed local time
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(utcAssumed);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';

  const displayedIso = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;

  // Diff between what UTC assumed and what the timezone displays
  const displayedAsUtc = new Date(`${displayedIso}Z`);
  const offsetMs = displayedAsUtc.getTime() - utcAssumed.getTime();

  // Subtract offset to convert localIso from zoned to UTC
  return new Date(utcAssumed.getTime() - offsetMs);
}

/**
 * Returns { from, to } UTC dates representing the closed-open interval [start of month, start of next month).
 */
export function monthBoundaries(
  year: number,
  month: number,
  timezone: string,
): { from: Date; to: Date } {
  const from = firstOfMonth(year, month, timezone);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const to = firstOfMonth(nextYear, nextMonth, timezone);
  return { from, to };
}

/**
 * Returns the current year and month in the given user timezone.
 */
export function currentYearMonth(timezone: string): { year: number; month: number } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const year = parseInt(parts.find((p) => p.type === 'year')?.value ?? '2024', 10);
  const month = parseInt(parts.find((p) => p.type === 'month')?.value ?? '1', 10);
  return { year, month };
}

/** Returns a YYYY-MM-01 string (first-of-month DATE) for use in budget period_month */
export function toPeriodMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}
