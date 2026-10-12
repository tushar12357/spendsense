import { describe, expect, it } from 'vitest';
import {
  addMonths,
  currentYearMonth,
  daysInMonth,
  firstOfMonth,
  isValidTimezone,
  monthBoundaries,
  monthsBetween,
  toLocalDate,
  zonedToUtc,
} from '../../src/shared/utils/date';

describe('timezone-aware month boundaries', () => {
  it('October in IST starts at 18:30Z on 30 September', () => {
    expect(firstOfMonth(2026, 10, 'Asia/Kolkata').toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('monthBoundaries is a half-open [from, to) interval', () => {
    const { from, to } = monthBoundaries(2026, 10, 'Asia/Kolkata');
    expect(from.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(to.toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });

  it('rolls December into January of the next year', () => {
    const { to } = monthBoundaries(2026, 12, 'UTC');
    expect(to.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('respects daylight saving time (America/New_York)', () => {
    // EST (UTC-5) on 1 Mar 2026; EDT (UTC-4) from 8 Mar, so 1 Apr is already UTC-4.
    expect(firstOfMonth(2026, 3, 'America/New_York').toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(firstOfMonth(2026, 4, 'America/New_York').toISOString()).toBe('2026-04-01T04:00:00.000Z');
  });

  it('zonedToUtc converts a wall-clock time', () => {
    expect(zonedToUtc({ year: 2026, month: 10, day: 5, hour: 12 }, 'Asia/Kolkata').toISOString()).toBe('2026-10-05T06:30:00.000Z');
  });
});

describe('local calendar helpers', () => {
  it('toLocalDate depends on the timezone', () => {
    const instant = new Date('2026-09-30T19:00:00Z');
    expect(toLocalDate(instant, 'UTC')).toBe('2026-09-30');
    expect(toLocalDate(instant, 'Asia/Kolkata')).toBe('2026-10-01');
  });

  it('currentYearMonth uses the user timezone', () => {
    const instant = new Date('2026-09-30T19:00:00Z');
    expect(currentYearMonth('UTC', instant)).toEqual({ year: 2026, month: 9 });
    expect(currentYearMonth('Asia/Kolkata', instant)).toEqual({ year: 2026, month: 10 });
  });

  it('addMonths handles year wrap in both directions', () => {
    expect(addMonths({ year: 2026, month: 11 }, 3)).toEqual({ year: 2027, month: 2 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 6 }, -12)).toEqual({ year: 2025, month: 6 });
  });

  it('daysInMonth knows leap years', () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 10)).toBe(31);
  });

  it('monthsBetween never goes negative', () => {
    expect(monthsBetween({ year: 2026, month: 10 }, { year: 2027, month: 2 })).toBe(4);
    expect(monthsBetween({ year: 2026, month: 10 }, { year: 2026, month: 1 })).toBe(0);
  });

  it('validates IANA timezones', () => {
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});
