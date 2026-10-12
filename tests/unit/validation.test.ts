import { describe, expect, it } from 'vitest';
import { categorize } from '../../src/modules/merchant-rules/categorizer';
import { AppError } from '../../src/shared/errors/AppError';
import { decodeCursor, decodeRowCursor, encodeCursor, encodeRowCursor } from '../../src/shared/validation/pagination.schema';
import { moneyString, positiveMoneyString, timezoneSchema } from '../../src/shared/validation/money';
import { registerSchema } from '../../src/modules/auth/auth.schema';
import { createTransactionSchema, transactionQuerySchema, updateTransactionSchema } from '../../src/modules/transactions/transactions.schema';

const UUID = '3f0c1f6e-8d3a-4c58-9e67-0f6f5a9c1b2d';

describe('cursor encoding', () => {
  it('round-trips a ledger cursor', () => {
    const at = new Date('2026-10-02T06:30:00.000Z');
    const decoded = decodeCursor(encodeCursor(UUID, at));
    expect(decoded.id).toBe(UUID);
    expect(decoded.occurredAt.toISOString()).toBe(at.toISOString());
  });

  it.each(['not-base64!!', Buffer.from('{"id":"x"}').toString('base64url'), Buffer.from(JSON.stringify({ id: UUID, occurredAt: 'nope' })).toString('base64url')])(
    'rejects tampered cursor %#',
    (bad) => {
      expect(() => decodeCursor(bad)).toThrow(AppError);
    },
  );

  it('round-trips and validates row cursors', () => {
    expect(decodeRowCursor(encodeRowCursor(42))).toBe(42);
    expect(() => decodeRowCursor(Buffer.from('{"r":-1}').toString('base64url'))).toThrow(AppError);
  });
});

describe('money validation', () => {
  it('accepts decimal strings with at most 2 places', () => {
    expect(moneyString.safeParse('0').success).toBe(true);
    expect(moneyString.safeParse('1234.5').success).toBe(true);
    expect(moneyString.safeParse('1234.56').success).toBe(true);
  });
  it.each(['-5', '1.234', '1e3', '', 'abc', '1,000', '9999999999999'])('rejects %j', (v) => {
    expect(moneyString.safeParse(v).success).toBe(false);
  });
  it('requires positive amounts when asked', () => {
    expect(positiveMoneyString.safeParse('0.00').success).toBe(false);
    expect(positiveMoneyString.safeParse('0.01').success).toBe(true);
  });
  it('validates IANA timezones', () => {
    expect(timezoneSchema.safeParse('Asia/Kolkata').success).toBe(true);
    expect(timezoneSchema.safeParse('Nowhere/City').success).toBe(false);
  });
});

describe('request schemas', () => {
  it('normalizes email and enforces password strength on register', () => {
    const ok = registerSchema.parse({ email: '  User@Example.COM ', password: 'CorrectHorse9', displayName: ' Asha ' });
    expect(ok.email).toBe('user@example.com');
    expect(ok.displayName).toBe('Asha');
    expect(ok.timezone).toBe('Asia/Kolkata');
    expect(registerSchema.safeParse({ email: 'a@b.co', password: 'short1', displayName: 'x' }).success).toBe(false);
    expect(registerSchema.safeParse({ email: 'a@b.co', password: 'onlyletterspassword', displayName: 'x' }).success).toBe(false);
  });

  it('rejects non-positive manual amounts and bad ids', () => {
    const base = { accountId: UUID, type: 'EXPENSE', description: 'x' };
    expect(createTransactionSchema.safeParse({ ...base, amount: '0' }).success).toBe(false);
    expect(createTransactionSchema.safeParse({ ...base, amount: '10.5', accountId: 'nope' }).success).toBe(false);
    expect(createTransactionSchema.safeParse({ ...base, amount: '10.50' }).success).toBe(true);
  });

  it('rejects an empty PATCH and an inverted date range', () => {
    expect(updateTransactionSchema.safeParse({}).success).toBe(false);
    expect(updateTransactionSchema.safeParse({ notes: null }).success).toBe(true);
    expect(transactionQuerySchema.safeParse({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }).success).toBe(false);
    expect(transactionQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });
});

describe('merchant categorizer', () => {
  const rules = [
    { pattern: 'swiggy instamart', categoryId: 'groceries', normalizedName: 'Swiggy Instamart' },
    { pattern: 'swiggy', categoryId: 'food', normalizedName: 'Swiggy' },
    { pattern: '  ', categoryId: 'ignored-blank', normalizedName: null },
  ];
  it('matches case-insensitively and honours rule order', () => {
    expect(categorize('UPI-SWIGGY INSTAMART BLR', rules)).toEqual({ categoryId: 'groceries', merchantName: 'Swiggy Instamart' });
    expect(categorize('upi-swiggy bangalore', rules)).toEqual({ categoryId: 'food', merchantName: 'Swiggy' });
  });
  it('returns null when nothing matches and never matches a blank pattern', () => {
    expect(categorize('ATM WDL', rules)).toBeNull();
  });
  it('treats regex metacharacters literally (no ReDoS surface)', () => {
    expect(categorize('a+b', [{ pattern: '(a+)+$', categoryId: 'x', normalizedName: null }])).toBeNull();
    expect(categorize('cost (a+)+$ here', [{ pattern: '(a+)+$', categoryId: 'x', normalizedName: null }])).not.toBeNull();
  });
});
