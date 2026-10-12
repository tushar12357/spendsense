import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/shared/utils/decimal';
import {
  addMonthsClamped,
  computeSafeToSpend,
  detectRecurring,
  forecastMonthEnd,
  merchantKey,
  requiredMonthlySaving,
  summarize,
  upcomingObligations,
  type RecurringInput,
} from '../../src/modules/analytics/finance';

const d = (v: string | number) => new Decimal(v);

describe('summarize (reporting policy)', () => {
  it('refunds reduce expenses; savings rate = (income - net expenses) / income', () => {
    const s = summarize({ income: d('100000'), expenses: d('40000.50'), refunds: d('500.50') });
    expect(s.netExpenses.toFixed(2)).toBe('39500.00');
    expect(s.netCashFlow.toFixed(2)).toBe('60500.00');
    expect(s.savingsRate!.toFixed(2)).toBe('60.50');
  });

  it('returns a null savings rate (not 0%) when there is no income', () => {
    expect(summarize({ income: d(0), expenses: d(500), refunds: d(0) }).savingsRate).toBeNull();
  });

  it('allows a negative savings rate when spending exceeds income', () => {
    expect(summarize({ income: d(1000), expenses: d(1500), refunds: d(0) }).savingsRate!.toFixed(2)).toBe('-50.00');
  });

  it('uses exact decimal arithmetic (0.1 + 0.2 === 0.3)', () => {
    const s = summarize({ income: d('0.30'), expenses: d('0.10').add('0.20'), refunds: d(0) });
    expect(s.netCashFlow.toFixed(2)).toBe('0.00');
  });
});

describe('forecastMonthEnd', () => {
  it('uses the run-rate when there is no history', () => {
    const f = forecastMonthEnd({ spentToDate: d('10000'), dayOfMonth: 10, daysInMonth: 30 });
    expect(f.method).toBe('run-rate');
    expect(f.projectedMonthEnd.toFixed(2)).toBe('30000.00');
    expect(f.confidence).toBe('medium');
    expect(f.daysRemaining).toBe(20);
  });

  it('blends with last month, trusting the run-rate more as the month progresses', () => {
    // day 15 of 30: weight 0.5 -> (30000 + 20000) / 2
    const f = forecastMonthEnd({ spentToDate: d('15000'), dayOfMonth: 15, daysInMonth: 30, previousMonthTotal: d('20000') });
    expect(f.method).toBe('blended-with-history');
    expect(f.projectedMonthEnd.toFixed(2)).toBe('25000.00');
    expect(f.confidence).toBe('high');
  });

  it('is always low confidence early in the month, and never below what is already spent', () => {
    const f = forecastMonthEnd({ spentToDate: d('30000'), dayOfMonth: 3, daysInMonth: 30, previousMonthTotal: d('1000') });
    expect(f.confidence).toBe('low');
    expect(f.projectedMonthEnd.greaterThanOrEqualTo(30000)).toBe(true);
    expect(f.notes.join(' ')).toMatch(/estimate/i);
  });

  it('handles day 1 and a zero spend without dividing by zero', () => {
    const f = forecastMonthEnd({ spentToDate: d(0), dayOfMonth: 1, daysInMonth: 31 });
    expect(f.projectedMonthEnd.toFixed(2)).toBe('0.00');
  });
});

describe('recurring detection', () => {
  const tx = (id: string, label: string, amount: string, localDate: string): RecurringInput => ({
    id, label, amount: d(amount), localDate, categoryId: null,
  });

  it('finds a monthly subscription despite reference noise in the description', () => {
    const found = detectRecurring([
      tx('1', 'NETFLIX.COM 123456', '649.00', '2026-07-05'),
      tx('2', 'NETFLIX.COM 998877', '649.00', '2026-08-05'),
      tx('3', 'NETFLIX.COM 445566', '649.00', '2026-09-05'),
      tx('4', 'NETFLIX.COM 112233', '649.00', '2026-10-05'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ frequency: 'MONTHLY', occurrences: 4, lastSeen: '2026-10-05', nextExpected: '2026-11-05', confidence: 'high' });
    expect(found[0]!.typicalAmount.toFixed(2)).toBe('649.00');
  });

  it('finds a weekly pattern', () => {
    const found = detectRecurring([
      tx('1', 'MILK SUBSCRIPTION', '120.00', '2026-10-01'),
      tx('2', 'MILK SUBSCRIPTION', '120.00', '2026-10-08'),
      tx('3', 'MILK SUBSCRIPTION', '120.00', '2026-10-15'),
    ]);
    expect(found[0]).toMatchObject({ frequency: 'WEEKLY', nextExpected: '2026-10-22' });
  });

  it('does not flag frequent but irregular purchases', () => {
    expect(
      detectRecurring([
        tx('1', 'UPI SWIGGY', '300.00', '2026-10-01'),
        tx('2', 'UPI SWIGGY', '300.00', '2026-10-03'),
        tx('3', 'UPI SWIGGY', '300.00', '2026-10-09'),
        tx('4', 'UPI SWIGGY', '300.00', '2026-10-20'),
      ]),
    ).toEqual([]);
  });

  it('needs at least three occurrences and similar amounts', () => {
    expect(detectRecurring([tx('1', 'GYM', '1500.00', '2026-08-01'), tx('2', 'GYM', '1500.00', '2026-09-01')])).toEqual([]);
    expect(
      detectRecurring([
        tx('1', 'AMAZON', '100.00', '2026-08-01'),
        tx('2', 'AMAZON', '5000.00', '2026-09-01'),
        tx('3', 'AMAZON', '12000.00', '2026-10-01'),
      ]),
    ).toEqual([]);
  });

  it('clamps month-end dates (31 Jan -> 28 Feb)', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsClamped('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('builds a stable merchant key', () => {
    expect(merchantKey('NETFLIX.COM 123456')).toBe(merchantKey('netflix com 998877'));
  });
});

describe('upcomingObligations', () => {
  const monthly = {
    key: 'rent', label: 'RENT', frequency: 'MONTHLY' as const, typicalAmount: d('25000'), occurrences: 3,
    lastSeen: '2026-09-03', nextExpected: '2026-10-03', confidence: 'high' as const, categoryId: null, transactionIds: [],
  };
  const weekly = { ...monthly, key: 'milk', label: 'MILK', frequency: 'WEEKLY' as const, typicalAmount: d('120'), lastSeen: '2026-10-08', nextExpected: '2026-10-15' };

  it('counts only charges still to come after today, up to month end', () => {
    // Rent already due on the 3rd (passed) -> rolls to November, beyond month end.
    const r = upcomingObligations([monthly], '2026-10-12', '2026-10-31');
    expect(r.total.toFixed(2)).toBe('0.00');
  });

  it('includes a monthly charge that is still ahead', () => {
    const r = upcomingObligations([{ ...monthly, nextExpected: '2026-10-20' }], '2026-10-12', '2026-10-31');
    expect(r.total.toFixed(2)).toBe('25000.00');
    expect(r.items[0]!.dueDate).toBe('2026-10-20');
  });

  it('counts every remaining weekly occurrence', () => {
    // 15th, 22nd, 29th
    const r = upcomingObligations([weekly], '2026-10-12', '2026-10-31');
    expect(r.items.map((i) => i.dueDate)).toEqual(['2026-10-15', '2026-10-22', '2026-10-29']);
    expect(r.total.toFixed(2)).toBe('360.00');
  });
});

describe('requiredMonthlySaving', () => {
  it('rounds UP to the paisa so the plan never falls short', () => {
    expect(requiredMonthlySaving(d('100'), 3)!.toFixed(2)).toBe('33.34');
  });
  it('is zero for an achieved goal and null without a target date', () => {
    expect(requiredMonthlySaving(d('0'), 3)!.toFixed(2)).toBe('0.00');
    expect(requiredMonthlySaving(d('500'), null)).toBeNull();
  });
  it('treats a past/current month as one remaining month', () => {
    expect(requiredMonthlySaving(d('900'), 0)!.toFixed(2)).toBe('900.00');
  });
});

describe('computeSafeToSpend', () => {
  const base = { daysRemaining: 10, assumptions: ['a'] };

  it('deducts only future obligations and the savings commitment from the balance', () => {
    const r = computeSafeToSpend({ ...base, availableBalance: d('50000'), upcomingObligations: d('12000'), remainingSavingsCommitment: d('8000') });
    expect(r.amount!.toFixed(2)).toBe('30000.00');
    expect(r.dailyAllowance!.toFixed(2)).toBe('3000.00');
    expect(r.isEstimate).toBe(true);
    expect(r.shortfall).toBe(false);
  });

  it('never invents a balance: unknown balance -> null answer', () => {
    const r = computeSafeToSpend({ ...base, availableBalance: null, upcomingObligations: d('100'), remainingSavingsCommitment: d(0) });
    expect(r.amount).toBeNull();
    expect(r.dailyAllowance).toBeNull();
  });

  it('flags a shortfall and floors the daily allowance at zero', () => {
    const r = computeSafeToSpend({ ...base, availableBalance: d('1000'), upcomingObligations: d('5000'), remainingSavingsCommitment: d(0) });
    expect(r.amount!.toFixed(2)).toBe('-4000.00');
    expect(r.shortfall).toBe(true);
    expect(r.dailyAllowance!.toFixed(2)).toBe('0.00');
  });

  it('rounds the daily allowance down, never promising more than exists', () => {
    const r = computeSafeToSpend({ ...base, daysRemaining: 3, availableBalance: d('100'), upcomingObligations: d(0), remainingSavingsCommitment: d(0) });
    expect(r.dailyAllowance!.toFixed(2)).toBe('33.33');
  });
});
