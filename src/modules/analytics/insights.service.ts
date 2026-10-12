// src/modules/analytics/insights.service.ts
// GET /insights: facts and clearly-labelled estimates about the current month.
//   facts     -> month-over-month comparison, budget status (derived from the ledger)
//   estimates -> month-end forecast, recurring candidates, safe-to-spend

import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { Decimal, ZERO, serializeAmount } from '../../shared/utils/decimal';
import {
  addMonths,
  daysInMonth,
  localParts,
  monthBoundaries,
  toLocalDate,
} from '../../shared/utils/date';
import { getAccountBalances } from '../accounts/accounts.service';
import { listBudgets } from '../budgets/budgets.service';
import { describeGoal } from '../savings-goals/savings-goals.service';
import { getMonthlyTrends, netExpensesBetween, resolvePeriod } from './analytics.service';
import {
  computeSafeToSpend,
  detectRecurring,
  forecastMonthEnd,
  upcomingObligations,
  type RecurringInput,
} from './finance';

const RECURRING_LOOKBACK_MONTHS = 6;
const RECURRING_MAX_ROWS = 5_000; // bounded: detection is O(n) over at most this many recent expenses
const LIQUID_ACCOUNT_TYPES = new Set(['SAVINGS', 'CURRENT', 'WALLET', 'CASH']);

async function loadRecurringInputs(userId: string, timezone: string, since: Date): Promise<RecurringInput[]> {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; label: string; amount: Prisma.Decimal; local_date: string; category_id: string | null }>
  >`
    SELECT id::text AS id,
           COALESCE(NULLIF(merchant_name, ''), description) AS label,
           amount,
           to_char(occurred_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS local_date,
           category_id::text AS category_id
    FROM transactions
    WHERE user_id = ${userId}::uuid
      AND type = 'EXPENSE'
      AND occurred_at >= ${since}::timestamptz
    ORDER BY occurred_at DESC
    LIMIT ${RECURRING_MAX_ROWS}
  `;
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    amount: new Decimal(r.amount),
    localDate: r.local_date,
    categoryId: r.category_id,
  }));
}

export async function getRecurringCandidates(userId: string, timezone: string, now: Date = new Date()) {
  const today = localParts(now, timezone);
  const since = monthBoundaries(
    addMonths(today, -RECURRING_LOOKBACK_MONTHS).year,
    addMonths(today, -RECURRING_LOOKBACK_MONTHS).month,
    timezone,
  ).from;
  return detectRecurring(await loadRecurringInputs(userId, timezone, since));
}

export async function getInsights(userId: string, timezone: string, now: Date = new Date()) {
  const period = resolvePeriod(timezone, undefined, undefined, now);
  const local = localParts(now, timezone);
  const dim = daysInMonth(period.year, period.month);
  const todayIso = toLocalDate(now, timezone);
  const monthEndIso = `${String(period.year).padStart(4, '0')}-${String(period.month).padStart(2, '0')}-${String(dim).padStart(2, '0')}`;
  const prev = addMonths(period, -1);
  const prevFrom = monthBoundaries(prev.year, prev.month, timezone).from;

  const [spentToDate, previousMonthTotal, trends, candidates, balances, accounts, budgets, goalRows] =
    await Promise.all([
      netExpensesBetween(userId, period.from, period.to),
      netExpensesBetween(userId, prevFrom, period.from),
      getMonthlyTrends(userId, timezone, 2, now),
      getRecurringCandidates(userId, timezone, now),
      getAccountBalances(userId),
      prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, type: true } }),
      listBudgets(userId, timezone, period.year, period.month),
      prisma.savingsGoal.findMany({
        where: { userId, status: 'ACTIVE' },
        select: {
          id: true, name: true, targetAmount: true, currentAmount: true, currency: true, targetDate: true,
          status: true, notes: true, createdAt: true, updatedAt: true,
        },
      }),
    ]);

  // ── Month-over-month (facts) ─────────────────────────────────────────────────
  const current = trends.months[trends.months.length - 1];
  const previous = trends.months.length > 1 ? trends.months[0] : undefined;

  // ── Forecast (estimate) ──────────────────────────────────────────────────────
  const forecast = forecastMonthEnd({
    spentToDate,
    dayOfMonth: local.day,
    daysInMonth: dim,
    previousMonthTotal: previousMonthTotal.greaterThan(0) ? previousMonthTotal : null,
  });

  // ── Safe to spend (estimate) ─────────────────────────────────────────────────
  const liquid = accounts.filter((a) => LIQUID_ACCOUNT_TYPES.has(a.type));
  const liquidBalances = liquid.flatMap((a) => (balances.has(a.id) ? [balances.get(a.id)!] : []));
  const availableBalance = liquid.length === 0 ? null : liquidBalances.reduce((s, b) => s.add(b.balance), ZERO);

  const { total: obligations, items: obligationItems } = upcomingObligations(candidates, todayIso, monthEndIso);

  const goals = goalRows.map((g) => describeGoal(g, timezone, now));
  const savingsCommitment = goals.reduce(
    (s, g) => (g.requiredMonthlySaving ? s.add(g.requiredMonthlySaving) : s),
    ZERO,
  );

  const assumptions = [
    'Account balances are derived from each account\'s opening balance plus its ledger (opening balance = balance before the first recorded transaction).',
    'Upcoming obligations are inferred from recurring spending patterns you have not confirmed.',
    'The savings commitment assumes nothing has been set aside for your goals yet this month.',
  ];
  if (liquidBalances.some((b) => b.hasTransfers)) {
    assumptions.push('Transfers between accounts are excluded from balances because their direction is not recorded.');
  }
  if (availableBalance === null) {
    assumptions.push('No cash/bank account exists yet, so no balance can be established.');
  }

  const safeToSpend = computeSafeToSpend({
    availableBalance,
    upcomingObligations: obligations,
    remainingSavingsCommitment: savingsCommitment,
    daysRemaining: dim - local.day + 1,
    assumptions,
  });

  return {
    period: { year: period.year, month: period.month, today: todayIso, daysRemaining: dim - local.day + 1 },
    currency: 'INR',
    monthOverMonth: current && {
      current: { month: current.month, income: current.income, netExpenses: current.netExpenses },
      previous: previous && { month: previous.month, income: previous.income, netExpenses: previous.netExpenses },
      incomeChangePct: current.incomeChangePct,
      expenseChangePct: current.expenseChangePct,
    },
    forecast: {
      isEstimate: true,
      spentToDate: serializeAmount(spentToDate),
      projectedMonthEnd: serializeAmount(forecast.projectedMonthEnd),
      previousMonthTotal: serializeAmount(previousMonthTotal),
      method: forecast.method,
      confidence: forecast.confidence,
      daysElapsed: forecast.daysElapsed,
      daysRemaining: forecast.daysRemaining,
      notes: forecast.notes,
    },
    safeToSpend: {
      isEstimate: true,
      amount: safeToSpend.amount === null ? null : serializeAmount(safeToSpend.amount),
      dailyAllowance: safeToSpend.dailyAllowance === null ? null : serializeAmount(safeToSpend.dailyAllowance),
      shortfall: safeToSpend.shortfall,
      breakdown: {
        availableBalance: availableBalance === null ? null : serializeAmount(availableBalance),
        upcomingObligations: serializeAmount(obligations),
        remainingSavingsCommitment: serializeAmount(savingsCommitment),
      },
      upcomingObligations: obligationItems.map((i) => ({ ...i, amount: serializeAmount(i.amount) })),
      assumptions: safeToSpend.assumptions,
    },
    recurringCandidates: candidates.map((c) => ({
      label: c.label,
      frequency: c.frequency,
      typicalAmount: serializeAmount(c.typicalAmount),
      occurrences: c.occurrences,
      lastSeen: c.lastSeen,
      nextExpected: c.nextExpected,
      confidence: c.confidence,
      categoryId: c.categoryId,
      status: 'UNCONFIRMED' as const,
    })),
    budgetAlerts: budgets.budgets
      .filter((b) => b.status !== 'ok')
      .map((b) => ({ category: b.category.name, status: b.status, utilizationPct: b.utilizationPct, remaining: b.remaining })),
    savingsGoals: goals.map((g) => ({
      id: g.id,
      name: g.name,
      progressPct: g.progressPct,
      requiredMonthlySaving: g.requiredMonthlySaving,
      isOverdue: g.isOverdue,
    })),
  };
}
