// src/modules/analytics/analytics.service.ts
// Reporting queries. PostgreSQL does the aggregation (never the whole ledger in JS):
//   - FILTER aggregates     -> several metrics from one scan of the period
//   - generate_series + LAG -> gap-free monthly series with month-over-month deltas
//   - AT TIME ZONE          -> month bucketing in the user's reporting timezone
// Prisma Client is used where a query is plain CRUD; everything here is parameterised $queryRaw.
//
// Reporting policy (docs/financial-rules.md):
//   income        = INCOME rows only
//   net expenses  = EXPENSE - REFUND
//   TRANSFER rows never contribute to income, expenses, or savings.

import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { Decimal, ZERO, percentOf, serializeAmount, serializePercent } from '../../shared/utils/decimal';
import {
  addMonths,
  currentYearMonth,
  formatYearMonth,
  monthBoundaries,
  type YearMonth,
} from '../../shared/utils/date';
import { summarize } from './finance';

type Money = Prisma.Decimal;

export interface Period extends YearMonth {
  from: Date;
  to: Date;
}

export function resolvePeriod(timezone: string, year?: number, month?: number, now: Date = new Date()): Period {
  const ym = year && month ? { year, month } : currentYearMonth(timezone, now);
  return { ...ym, ...monthBoundaries(ym.year, ym.month, timezone) };
}

// ── Dashboard summary ──────────────────────────────────────────────────────────

export async function getDashboardSummary(userId: string, timezone: string, year?: number, month?: number) {
  const period = resolvePeriod(timezone, year, month);

  const [row] = await prisma.$queryRaw<
    Array<{
      income: Money; expenses: Money; refunds: Money;
      transaction_count: bigint; transfer_count: bigint; uncategorized_count: bigint;
    }>
  >`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE type = 'INCOME'),  0) AS income,
      COALESCE(SUM(amount) FILTER (WHERE type = 'EXPENSE'), 0) AS expenses,
      COALESCE(SUM(amount) FILTER (WHERE type = 'REFUND'),  0) AS refunds,
      COUNT(*)                                                  AS transaction_count,
      COUNT(*) FILTER (WHERE type = 'TRANSFER')                 AS transfer_count,
      COUNT(*) FILTER (WHERE category_id IS NULL AND type <> 'TRANSFER') AS uncategorized_count
    FROM transactions
    WHERE user_id = ${userId}::uuid
      AND occurred_at >= ${period.from}::timestamptz
      AND occurred_at <  ${period.to}::timestamptz
  `;

  const income = new Decimal(row?.income ?? 0);
  const expenses = new Decimal(row?.expenses ?? 0);
  const refunds = new Decimal(row?.refunds ?? 0);
  const { netExpenses, netCashFlow, savingsRate } = summarize({ income, expenses, refunds });

  return {
    period: { year: period.year, month: period.month, label: formatYearMonth(period), timezone },
    currency: 'INR',
    totalIncome: serializeAmount(income),
    totalExpenses: serializeAmount(expenses),
    totalRefunds: serializeAmount(refunds),
    netExpenses: serializeAmount(netExpenses),
    netCashFlow: serializeAmount(netCashFlow),
    savingsRate: serializePercent(savingsRate), // null when income is zero (undefined, not 0%)
    transactionCount: Number(row?.transaction_count ?? 0),
    transferCount: Number(row?.transfer_count ?? 0),
    uncategorizedCount: Number(row?.uncategorized_count ?? 0),
  };
}

// ── Category breakdown (with month-over-month) ─────────────────────────────────

export async function getCategoryBreakdown(userId: string, timezone: string, year?: number, month?: number) {
  const period = resolvePeriod(timezone, year, month);
  const prev = addMonths(period, -1);
  const prevFrom = monthBoundaries(prev.year, prev.month, timezone).from;

  const rows = await prisma.$queryRaw<
    Array<{
      category_id: string | null; category_name: string | null; color: string | null;
      total: Money; previous_total: Money; transaction_count: bigint;
    }>
  >`
    SELECT
      t.category_id::text AS category_id,
      c.name              AS category_name,
      c.color             AS color,
      COALESCE(SUM(CASE WHEN t.type = 'REFUND' THEN -t.amount ELSE t.amount END)
        FILTER (WHERE t.occurred_at >= ${period.from}::timestamptz AND t.occurred_at < ${period.to}::timestamptz), 0) AS total,
      COALESCE(SUM(CASE WHEN t.type = 'REFUND' THEN -t.amount ELSE t.amount END)
        FILTER (WHERE t.occurred_at >= ${prevFrom}::timestamptz AND t.occurred_at < ${period.from}::timestamptz), 0) AS previous_total,
      COUNT(*) FILTER (WHERE t.occurred_at >= ${period.from}::timestamptz AND t.occurred_at < ${period.to}::timestamptz) AS transaction_count
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ${userId}::uuid
      AND t.type IN ('EXPENSE', 'REFUND')
      AND t.occurred_at >= ${prevFrom}::timestamptz
      AND t.occurred_at <  ${period.to}::timestamptz
    GROUP BY t.category_id, c.name, c.color
    ORDER BY total DESC, c.name
  `;

  const total = rows.reduce((s, r) => s.add(r.total), ZERO);

  return {
    period: { year: period.year, month: period.month, label: formatYearMonth(period) },
    currency: 'INR',
    total: serializeAmount(total),
    categories: rows.map((r) => {
      const current = new Decimal(r.total);
      const previous = new Decimal(r.previous_total);
      return {
        categoryId: r.category_id,
        categoryName: r.category_name ?? 'Uncategorized',
        color: r.color,
        total: serializeAmount(current),
        percentage: serializePercent(percentOf(current, total)),
        previousTotal: serializeAmount(previous),
        changePct: serializePercent(previous.isZero() ? null : percentOf(current.sub(previous), previous.abs())),
        transactionCount: Number(r.transaction_count),
      };
    }),
  };
}

// ── Monthly trends ─────────────────────────────────────────────────────────────

export async function getMonthlyTrends(userId: string, timezone: string, months: number, now: Date = new Date()) {
  const end = currentYearMonth(timezone, now);
  const start = addMonths(end, -(months - 1));
  const from = monthBoundaries(start.year, start.month, timezone).from;
  const to = monthBoundaries(end.year, end.month, timezone).to;

  // generate_series guarantees a row for every month (zeros where nothing happened), so LAG
  // compares genuinely adjacent months instead of skipping over empty ones.
  const rows = await prisma.$queryRaw<
    Array<{
      month: string; income: Money; expenses: Money; refunds: Money;
      prev_income: Money | null; prev_net_expenses: Money | null;
    }>
  >`
    WITH months AS (
      SELECT generate_series(
        make_date(${start.year}::int, ${start.month}::int, 1)::timestamp,
        make_date(${end.year}::int,   ${end.month}::int,   1)::timestamp,
        interval '1 month') AS month
    ),
    monthly AS (
      SELECT
        date_trunc('month', occurred_at AT TIME ZONE ${timezone}) AS month,
        SUM(amount) FILTER (WHERE type = 'INCOME')  AS income,
        SUM(amount) FILTER (WHERE type = 'EXPENSE') AS expenses,
        SUM(amount) FILTER (WHERE type = 'REFUND')  AS refunds
      FROM transactions
      WHERE user_id = ${userId}::uuid
        AND occurred_at >= ${from}::timestamptz
        AND occurred_at <  ${to}::timestamptz
      GROUP BY 1
    ),
    filled AS (
      SELECT m.month,
             COALESCE(x.income, 0)   AS income,
             COALESCE(x.expenses, 0) AS expenses,
             COALESCE(x.refunds, 0)  AS refunds
      FROM months m LEFT JOIN monthly x ON x.month = m.month
    )
    SELECT
      to_char(month, 'YYYY-MM') AS month,
      income, expenses, refunds,
      LAG(income)               OVER w AS prev_income,
      LAG(expenses - refunds)   OVER w AS prev_net_expenses
    FROM filled
    WINDOW w AS (ORDER BY month)
    ORDER BY month
  `;

  return {
    currency: 'INR',
    months: rows.map((r) => {
      const income = new Decimal(r.income);
      const netExpenses = new Decimal(r.expenses).sub(r.refunds);
      const { netCashFlow, savingsRate } = summarize({ income, expenses: new Decimal(r.expenses), refunds: new Decimal(r.refunds) });
      const change = (cur: Decimal, prev: Money | null) =>
        prev === null || new Decimal(prev).isZero() ? null : percentOf(cur.sub(prev), new Decimal(prev).abs());
      return {
        month: r.month,
        income: serializeAmount(income),
        netExpenses: serializeAmount(netExpenses),
        netCashFlow: serializeAmount(netCashFlow),
        savingsRate: serializePercent(savingsRate),
        incomeChangePct: serializePercent(change(income, r.prev_income)),
        expenseChangePct: serializePercent(change(netExpenses, r.prev_net_expenses)),
      };
    }),
  };
}

// ── Helpers reused by insights ─────────────────────────────────────────────────

/** Net expenses (EXPENSE - REFUND) inside [from, to). */
export async function netExpensesBetween(userId: string, from: Date, to: Date): Promise<Decimal> {
  const [row] = await prisma.$queryRaw<Array<{ net: Money }>>`
    SELECT COALESCE(SUM(CASE WHEN type = 'REFUND' THEN -amount ELSE amount END), 0) AS net
    FROM transactions
    WHERE user_id = ${userId}::uuid
      AND type IN ('EXPENSE', 'REFUND')
      AND occurred_at >= ${from}::timestamptz
      AND occurred_at <  ${to}::timestamptz
  `;
  return new Decimal(row?.net ?? 0);
}
