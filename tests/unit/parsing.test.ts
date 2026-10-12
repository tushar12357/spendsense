import { describe, expect, it } from 'vitest';
import { AdapterRowError } from '../../src/modules/imports/adapters/adapter.interface';
import { parseAmountCell, parseDateCell } from '../../src/modules/imports/adapters/parsing';

describe('parseAmountCell', () => {
  it('parses Indian digit grouping exactly', () => {
    expect(parseAmountCell('1,23,456.78')!.toFixed(2)).toBe('123456.78');
  });

  it('treats blank and dash as "no value"', () => {
    expect(parseAmountCell('')).toBeNull();
    expect(parseAmountCell('  ')).toBeNull();
    expect(parseAmountCell('-')).toBeNull();
    expect(parseAmountCell(undefined)).toBeNull();
  });

  it('strips currency markers and handles accounting negatives', () => {
    expect(parseAmountCell('₹ 1,200.50')!.toFixed(2)).toBe('1200.50');
    expect(parseAmountCell('Rs. 99')!.toFixed(2)).toBe('99.00');
    expect(parseAmountCell('(1,200.00)')!.toFixed(2)).toBe('-1200.00');
    expect(parseAmountCell('-45.5')!.toFixed(2)).toBe('-45.50');
    expect(parseAmountCell('250.00Dr')!.toFixed(2)).toBe('250.00');
  });

  it('keeps full precision (no float rounding)', () => {
    expect(parseAmountCell('0.10')!.add(parseAmountCell('0.20')!).toString()).toBe('0.3');
  });

  it('rejects junk and sub-paisa precision', () => {
    expect(() => parseAmountCell('abc')).toThrow(AdapterRowError);
    expect(() => parseAmountCell('12.345')).toThrow(AdapterRowError);
    expect(() => parseAmountCell('1.2.3')).toThrow(AdapterRowError);
  });
});

describe('parseDateCell', () => {
  it('parses DD/MM/YY with a 2000s pivot', () => {
    expect(parseDateCell('01/10/26')).toBe('2026-10-01');
    expect(parseDateCell('31/12/99')).toBe('1999-12-31');
  });

  it('parses DD/MM/YYYY, dashes, dots and ISO', () => {
    expect(parseDateCell('2/10/2026')).toBe('2026-10-02');
    expect(parseDateCell('02-10-2026')).toBe('2026-10-02');
    expect(parseDateCell('02.10.2026')).toBe('2026-10-02');
    expect(parseDateCell('2026-10-02')).toBe('2026-10-02');
  });

  it('rejects impossible dates instead of rolling them over', () => {
    expect(() => parseDateCell('31/02/2026')).toThrow(AdapterRowError);
    expect(() => parseDateCell('32/01/2026')).toThrow(AdapterRowError);
    expect(() => parseDateCell('00/01/2026')).toThrow(AdapterRowError);
    expect(() => parseDateCell('2026-13-01')).toThrow(AdapterRowError);
  });

  it('rejects unparseable text and blanks', () => {
    expect(() => parseDateCell('yesterday')).toThrow(AdapterRowError);
    expect(() => parseDateCell('')).toThrow(AdapterRowError);
    expect(() => parseDateCell(undefined)).toThrow(AdapterRowError);
  });

  it('accepts 29 Feb only in leap years', () => {
    expect(parseDateCell('29/02/2028')).toBe('2028-02-29');
    expect(() => parseDateCell('29/02/2026')).toThrow(AdapterRowError);
  });
});
