// src/modules/analytics/analytics.service.ts
// Analytics queries using parameterized raw SQL for PostgreSQL-specific capabilities.
// Prisma Client is used for simple CRUD; raw SQL is used here for:
//   - DATE_TRUNC + AT TIME ZONE for timezone-aware month bucketing
//   - Window functions (LAG) for month-over-month trends
//   - Multi-CTE aggregations for dashboard summary
//
// All queries use tagged template literals ($queryRaw) — never string concatenation.
// TRANSFERS are excluded from income/expense totals per financial rules.
// REFUNDS reduce expense totals (not counted as income).

import { prisma } from '../../infrastructure/database/prisma';
import { Decimal, serializeAmount } from '../../shared/utils/decimal';
import { monthBoundaries, currentYearMonth } from '../../shared/utils/date';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MonthlySummaryRow {
  total_income: Decimal;
  total_expenses: Decimal;
  total_refunds: Decimal;
  transaction_count: bigint;
}

interface CategoryBreakdownRow {
  category_id: string | null;
  category_name: string | null;
  total: Decimal;
  transaction_count: bigint;
}

interface TrendRow {
  month: Date;
  income: Decimal;
  expenses: Decimal;
  refunds: Decimal;
  prev_income: Decimal | null;
  prev_expenses: Decimal | null;
}

// ── Dashboard Summary ─────────────────────────────────────────────────────────

export async function getDashboardSummary(userId: string, userTimezone: string) {
  const { year, month } = currentYearMonth(userTimezone);
  const { from, to } = monthBoundaries(year, month, userTimezone);

  const rows = await prisma.$queryRaw<MonthlySummaryRow[]>`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'INCOME'  THEN amount ELSE 0 END), 0) AS total_income,
      COALESCE(SUM(CASE WHEN type = 'EXPENSE' THEN amount ELSE 0 END), 0) AS total_expenses,
      COALESCE(SUM(CASE WHEN type = 'REFUND'  THEN amount ELSE 0 END), 0) AS total_refunds,
      COUNT(*)::bigint AS transaction_count
    FROM transactions
    WHERE user_id = ${userId}::uuid
      AND type != 'TRANSFER'
      AND occurred_at >= ${from}
      AND occurred_at <  ${to}
  `;

  const row = rows[0] ?? {
    total_income: new Decimal(0),
    total_expenses: new Decimal(0),
    total_refunds: new Decimal(0),
    transaction_count: BigInt(0),
  };

  const income = new Decimal(row.total_income);
  const expenses = new Decimal(row.total_expenses);
  const refunds = new Decimal(row.total_refunds);
  const netExpenses = expenses.sub(refunds);
  const netCashFlow = income.sub(netExpenses);
  const savingsRateVal = income.isZero()
    ? null
    : income.sub(netExpenses).div(income).mul(100);

  return {
    period: { year, month },
    currency: 'INR',
    totalIncome: serializeAmount(income),
    totalExpenses: serializeAmount(expenses),
    totalRefunds: serializeAmount(refunds),
    netExpenses: serializeAmount(netExpenses),
    netCashFlow: serializeAmount(netCashFlow),
    savingsRate: savingsRateVal ? serializeAmount(savingsRateVal) : null,
    transactionCount: Number(row.transaction_count),
  };
}

// ── Category Breakdown ────────────────────────────────────────────────────────

export async function getCategoryBreakdown(
  userId: string,
  userTimezone: string,
  year?: number,
  month?: number,
) {
  const ym = year && month ? { year, month } : currentYearMonth(userTimezone);
  const { from, to } = monthBoundaries(ym.year, ym.month, userTimezone);

  const rows = await prisma.$queryRaw<CategoryBreakdownRow[]>`
    SELECT
      t.category_id,
      c.name AS category_name,
      COALESCE(SUM(
        CASE WHEN t.type = 'REFUND' THEN -t.amount ELSE t.amount END
      ), 0) AS total,
      COUNT(*)::bigint AS transaction_count
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ${userId}::uuid
      AND t.type IN ('EXPENSE', 'REFUND')
      AND occurred_at >= ${from}
      AND occurred_at <  ${to}
    GROUP BY t.category_id, c.name
    ORDER BY total DESC
  `;

  const grandTotal = rows.reduce(
    (sum: Decimal, r: CategoryBreakdownRow) => sum.add(new Decimal(r.total)),
    new Decimal(0),
  );

  return rows.map((r: CategoryBreakdownRow) => {
    const total = new Decimal(r.total);
    const pct = grandTotal.isZero() ? null : total.div(grandTotal).mul(100);
    return {
      categoryId: r.category_id,
      categoryName: r.category_name ?? 'Uncategorized',
      total: serializeAmount(total),
      percentage: pct ? serializeAmount(pct) : null,
      transactionCount: Number(r.transaction_count),
    };
  });
}

// ── Monthly Trends with LAG window function ───────────────────────────────────

export async function getMonthlyTrends(userId: string, userTimezone: string, months = 12) {
  // DATE_TRUNC in user timezone using AT TIME ZONE
  const rows = await prisma.$queryRaw<TrendRow[]>`
    WITH monthly AS (
      SELECT
        DATE_TRUNC('month', occurred_at AT TIME ZONE ${userTimezone}) AS month,
        COALESCE(SUM(CASE WHEN type = 'INCOME'  THEN amount ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN type = 'EXPENSE' THEN amount ELSE 0 END), 0) AS expenses,
        COALESCE(SUM(CASE WHEN type = 'REFUND'  THEN amount ELSE 0 END), 0) AS refunds
      FROM transactions
      WHERE user_id = ${userId}::uuid
        AND type != 'TRANSFER'
        AND occurred_at >= (NOW() AT TIME ZONE ${userTimezone} - INTERVAL '1 month' * ${months})
      GROUP BY 1
    )
    SELECT
      month,
      income,
      expenses,
      refunds,
      LAG(income,   1) OVER (ORDER BY month) AS prev_income,
      LAG(expenses, 1) OVER (ORDER BY month) AS prev_expenses
    FROM monthly
    ORDER BY month ASC
  `;

  return rows.map((r: TrendRow) => {
    const income = new Decimal(r.income);
    const expenses = new Decimal(r.expenses).sub(new Decimal(r.refunds));
    const prevIncome = r.prev_income ? new Decimal(r.prev_income) : null;
    const prevExpenses = r.prev_expenses ? new Decimal(r.prev_expenses) : null;

    const incomeChange =
      prevIncome && !prevIncome.isZero()
        ? income.sub(prevIncome).div(prevIncome).mul(100)
        : null;
    const expenseChange =
      prevExpenses && !prevExpenses.isZero()
        ? expenses.sub(prevExpenses).div(prevExpenses).mul(100)
        : null;

    return {
      month: r.month,
      income: serializeAmount(income),
      netExpenses: serializeAmount(expenses),
      incomeChangePct: incomeChange ? serializeAmount(incomeChange) : null,
      expenseChangePct: expenseChange ? serializeAmount(expenseChange) : null,
    };
  });
}
