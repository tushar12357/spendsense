// src/modules/analytics/finance.ts
// Pure financial rules. No I/O, no clock access: every function takes its inputs explicitly so the
// rules documented in docs/financial-rules.md can be unit-tested with exact expected values.

import { Decimal, ZERO, savingsRate } from '../../shared/utils/decimal';
import { normalizeDescription } from '../../shared/utils/fingerprint';

// ── Period totals ──────────────────────────────────────────────────────────────

export interface PeriodTotals {
  income: Decimal;
  expenses: Decimal;
  refunds: Decimal;
}

/**
 * Reporting policy:
 *  - TRANSFERS never appear here (callers exclude them).
 *  - REFUNDS reduce expenses (net expenses), they are not income.
 *  - net cash flow = income - net expenses; savings rate = net cash flow / income x 100.
 */
export function summarize({ income, expenses, refunds }: PeriodTotals) {
  const netExpenses = expenses.sub(refunds);
  const netCashFlow = income.sub(netExpenses);
  return { netExpenses, netCashFlow, savingsRate: savingsRate(income, netExpenses) };
}

// ── Month-end forecast ─────────────────────────────────────────────────────────

export type Confidence = 'low' | 'medium' | 'high';

export interface ForecastInput {
  /** Net expenses so far this month. */
  spentToDate: Decimal;
  /** 1-based day of the month, in the user's timezone (today counts as elapsed). */
  dayOfMonth: number;
  daysInMonth: number;
  /** Net expenses of the previous full month, when there is history. */
  previousMonthTotal?: Decimal | null;
}

export interface Forecast {
  projectedMonthEnd: Decimal;
  method: 'run-rate' | 'blended-with-history';
  confidence: Confidence;
  daysElapsed: number;
  daysRemaining: number;
  notes: string[];
}

/**
 * Projects month-end spending.
 *  - run-rate:  spent / elapsed days x days in month.
 *  - With history, blends the run-rate with last month's total, weighting the run-rate by how
 *    much of the month has elapsed (day 5 of 30 -> mostly history; day 25 -> mostly run-rate).
 * The projection is never below what has already been spent. Spending is not uniform (rent and
 * bills cluster early), so early-month confidence is always "low".
 */
export function forecastMonthEnd(input: ForecastInput): Forecast {
  const { spentToDate, dayOfMonth, daysInMonth } = input;
  const elapsed = Math.min(Math.max(dayOfMonth, 1), daysInMonth);
  const runRate = spentToDate.div(elapsed).mul(daysInMonth);

  const prev = input.previousMonthTotal ?? null;
  const hasHistory = prev !== null && prev.greaterThan(0);
  const weight = new Decimal(elapsed).div(daysInMonth);

  let projected = hasHistory ? runRate.mul(weight).add(prev!.mul(new Decimal(1).sub(weight))) : runRate;
  if (projected.lessThan(spentToDate)) projected = spentToDate;

  const confidence: Confidence = elapsed < 7 ? 'low' : elapsed < 15 || !hasHistory ? 'medium' : 'high';

  const notes: string[] = ['This is an estimate, not a confirmed figure.'];
  if (elapsed < 7) notes.push('Very early in the month: a few large payments can change this a lot.');
  if (!hasHistory) notes.push('No previous full month to compare with; using the current run-rate only.');

  return {
    projectedMonthEnd: projected.toDecimalPlaces(2),
    method: hasHistory ? 'blended-with-history' : 'run-rate',
    confidence,
    daysElapsed: elapsed,
    daysRemaining: daysInMonth - elapsed,
    notes,
  };
}

// ── Recurring-expense detection ────────────────────────────────────────────────

export interface RecurringInput {
  id: string;
  /** Merchant name when known, otherwise the raw description. */
  label: string;
  amount: Decimal;
  /** Local calendar date YYYY-MM-DD. */
  localDate: string;
  categoryId: string | null;
}

export interface RecurringCandidate {
  key: string;
  label: string;
  frequency: 'WEEKLY' | 'MONTHLY';
  typicalAmount: Decimal;
  occurrences: number;
  lastSeen: string;
  nextExpected: string;
  confidence: Confidence;
  categoryId: string | null;
  transactionIds: string[];
}

const DAY_MS = 86_400_000;

function toMs(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

export function addDays(isoDate: string, days: number): string {
  return new Date(toMs(isoDate) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Same day-of-month `months` later, clamped to the month length (31 Jan + 1 -> 28/29 Feb). */
export function addMonthsClamped(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return new Date(Date.UTC(ny, nm - 1, Math.min(d, last))).toISOString().slice(0, 10);
}

/** Stable grouping key: lowercase words, digits/reference noise removed, first three words. */
export function merchantKey(label: string): string {
  return normalizeDescription(label)
    .split(' ')
    .filter((w) => w.length > 1 && !/\d/.test(w))
    .slice(0, 3)
    .join(' ');
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function medianDecimal(values: Decimal[]): Decimal {
  const s = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : s[mid - 1]!.add(s[mid]!).div(2).toDecimalPlaces(2);
}

/** Splits one merchant's charges into clusters of similar amounts (within 10% or Rs 10). */
function clusterByAmount(items: RecurringInput[]): RecurringInput[][] {
  const sorted = [...items].sort((a, b) => a.amount.comparedTo(b.amount));
  const clusters: RecurringInput[][] = [];
  for (const item of sorted) {
    const current = clusters[clusters.length - 1];
    if (current) {
      const base = current[0]!.amount;
      const tolerance = Decimal.max(base.mul('0.10'), 10);
      if (item.amount.sub(base).abs().lessThanOrEqualTo(tolerance)) {
        current.push(item);
        continue;
      }
    }
    clusters.push([item]);
  }
  return clusters;
}

/**
 * Deterministic recurring-expense detection. A candidate needs >= 3 similar-amount charges from
 * one merchant whose gaps are consistently ~weekly (6-8 days) or ~monthly (26-35 days).
 * Candidates are SUGGESTIONS for the user to confirm; they are never treated as facts.
 */
export function detectRecurring(expenses: RecurringInput[]): RecurringCandidate[] {
  const groups = new Map<string, RecurringInput[]>();
  for (const e of expenses) {
    const key = merchantKey(e.label);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }

  const out: RecurringCandidate[] = [];
  for (const [key, items] of groups) {
    for (const cluster of clusterByAmount(items)) {
      if (cluster.length < 3) continue;
      const byDate = [...cluster].sort((a, b) => a.localDate.localeCompare(b.localDate));
      const gaps = byDate.slice(1).map((c, i) => Math.round((toMs(c.localDate) - toMs(byDate[i]!.localDate)) / DAY_MS));
      const mid = median(gaps);

      let frequency: 'WEEKLY' | 'MONTHLY' | null = null;
      let inBand: (g: number) => boolean = () => false;
      if (mid >= 6 && mid <= 8) {
        frequency = 'WEEKLY';
        inBand = (g) => g >= 5 && g <= 9;
      } else if (mid >= 26 && mid <= 35) {
        frequency = 'MONTHLY';
        inBand = (g) => g >= 25 && g <= 37;
      }
      if (!frequency) continue;

      const consistent = gaps.filter(inBand).length / gaps.length;
      if (consistent < 0.75) continue;

      const last = byDate[byDate.length - 1]!;
      out.push({
        key,
        label: last.label,
        frequency,
        typicalAmount: medianDecimal(cluster.map((c) => c.amount)),
        occurrences: cluster.length,
        lastSeen: last.localDate,
        nextExpected: frequency === 'WEEKLY' ? addDays(last.localDate, 7) : addMonthsClamped(last.localDate, 1),
        confidence: consistent === 1 && cluster.length >= 4 ? 'high' : 'medium',
        categoryId: last.categoryId,
        transactionIds: byDate.map((c) => c.id),
      });
    }
  }
  return out.sort((a, b) => b.typicalAmount.comparedTo(a.typicalAmount));
}

/**
 * Charges still expected between `today` (exclusive) and `monthEnd` (inclusive) for each candidate.
 * Weekly items can repeat several times within the remainder of the month.
 */
export function upcomingObligations(
  candidates: RecurringCandidate[],
  today: string,
  monthEnd: string,
): { total: Decimal; items: Array<{ label: string; amount: Decimal; dueDate: string }> } {
  const items: Array<{ label: string; amount: Decimal; dueDate: string }> = [];
  for (const c of candidates) {
    let due = c.nextExpected;
    // Roll an overdue expectation forward so a skipped cycle is not counted as "due in the past".
    while (due <= today) due = c.frequency === 'WEEKLY' ? addDays(due, 7) : addMonthsClamped(due, 1);
    while (due <= monthEnd) {
      items.push({ label: c.label, amount: c.typicalAmount, dueDate: due });
      due = c.frequency === 'WEEKLY' ? addDays(due, 7) : addMonthsClamped(due, 1);
    }
  }
  const total = items.reduce((sum, i) => sum.add(i.amount), ZERO);
  return { total, items: items.sort((a, b) => a.dueDate.localeCompare(b.dueDate)) };
}

// ── Savings goals ──────────────────────────────────────────────────────────────

/**
 * Amount to set aside per remaining month to reach the goal by its target date.
 * Rounded UP to the paisa so the plan never falls short. Goals with no date need no schedule.
 */
export function requiredMonthlySaving(
  remaining: Decimal,
  monthsLeftInclusive: number | null,
): Decimal | null {
  if (monthsLeftInclusive === null) return null;
  if (remaining.lessThanOrEqualTo(0)) return ZERO;
  return remaining.div(Math.max(1, monthsLeftInclusive)).toDecimalPlaces(2, Decimal.ROUND_UP);
}

// ── Safe to spend ──────────────────────────────────────────────────────────────

export interface SafeToSpendInput {
  /** Ledger-derived balance across liquid accounts, or null if it cannot be established. */
  availableBalance: Decimal | null;
  upcomingObligations: Decimal;
  remainingSavingsCommitment: Decimal;
  /** Days left in the month including today (>= 1). */
  daysRemaining: number;
  assumptions: string[];
}

export interface SafeToSpend {
  isEstimate: true;
  amount: Decimal | null;
  dailyAllowance: Decimal | null;
  shortfall: boolean;
  breakdown: {
    availableBalance: Decimal | null;
    upcomingObligations: Decimal;
    remainingSavingsCommitment: Decimal;
  };
  assumptions: string[];
}

/**
 * safe-to-spend = available balance - upcoming obligations - remaining savings commitment.
 *
 * Nothing is subtracted twice: `availableBalance` already reflects every transaction up to today,
 * so only FUTURE (not-yet-posted) obligations are deducted. Without an established balance the
 * answer is null - a balance is never invented. The result is always labelled an estimate because
 * obligations come from unconfirmed recurring-pattern detection.
 */
export function computeSafeToSpend(input: SafeToSpendInput): SafeToSpend {
  const { availableBalance, upcomingObligations: obligations, remainingSavingsCommitment: savings } = input;
  const base = {
    isEstimate: true as const,
    breakdown: { availableBalance, upcomingObligations: obligations, remainingSavingsCommitment: savings },
    assumptions: input.assumptions,
  };
  if (availableBalance === null) {
    return { ...base, amount: null, dailyAllowance: null, shortfall: false };
  }
  const amount = availableBalance.sub(obligations).sub(savings);
  const days = Math.max(1, input.daysRemaining);
  return {
    ...base,
    amount,
    shortfall: amount.isNegative(),
    dailyAllowance: amount.isNegative() ? ZERO : amount.div(days).toDecimalPlaces(2, Decimal.ROUND_DOWN),
  };
}
