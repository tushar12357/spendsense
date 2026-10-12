// src/modules/budgets/budgets.service.ts
// Budgets are monthly limits per category. Spending is NEVER stored on the budget: utilization is
// always derived from the ledger, so category corrections and refunds show up immediately.

import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';
import { Decimal, ZERO, percentOf, serializeAmount, serializePercent } from '../../shared/utils/decimal';
import { currentYearMonth, monthBoundaries, toPeriodMonth } from '../../shared/utils/date';
import { positiveMoneyString } from '../../shared/validation/money';
import { isCategoryVisible } from '../categories/categories.service';

export const upsertBudgetSchema = z
  .object({
    amount: positiveMoneyString,
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
  })
  .refine((v) => (v.year === undefined) === (v.month === undefined), {
    message: 'year and month must be provided together',
  });

export type UpsertBudgetInput = z.infer<typeof upsertBudgetSchema>;

const WARNING_THRESHOLD = new Decimal(80);
const HUNDRED = new Decimal(100);

type BudgetStatus = 'ok' | 'warning' | 'exceeded';

export function budgetStatus(utilizationPct: Decimal | null): BudgetStatus {
  if (utilizationPct === null) return 'ok';
  if (utilizationPct.greaterThan(HUNDRED)) return 'exceeded';
  if (utilizationPct.greaterThanOrEqualTo(WARNING_THRESHOLD)) return 'warning';
  return 'ok';
}

export async function listBudgets(userId: string, timezone: string, year?: number, month?: number) {
  const ym = year && month ? { year, month } : currentYearMonth(timezone);
  const { from, to } = monthBoundaries(ym.year, ym.month, timezone);

  const budgets = await prisma.budget.findMany({
    where: { userId, periodMonth: toPeriodMonth(ym.year, ym.month) },
    orderBy: { category: { name: 'asc' } },
    select: {
      id: true, amount: true, currency: true,
      category: { select: { id: true, name: true, icon: true, color: true } },
    },
  });

  // One grouped query for every budgeted category (refunds reduce spend).
  const spentRows =
    budgets.length === 0
      ? []
      : await prisma.$queryRaw<Array<{ category_id: string; spent: Prisma.Decimal }>>`
          SELECT category_id::text AS category_id,
                 COALESCE(SUM(CASE WHEN type = 'REFUND' THEN -amount ELSE amount END), 0) AS spent
          FROM transactions
          WHERE user_id = ${userId}::uuid
            AND type IN ('EXPENSE', 'REFUND')
            AND occurred_at >= ${from}::timestamptz
            AND occurred_at <  ${to}::timestamptz
            AND category_id = ANY(${budgets.map((b) => b.category.id)}::uuid[])
          GROUP BY category_id`;
  const spentBy = new Map(spentRows.map((r) => [r.category_id, new Decimal(r.spent)]));

  const items = budgets.map((b) => {
    const spent = spentBy.get(b.category.id) ?? ZERO;
    const utilization = percentOf(spent, b.amount);
    return {
      id: b.id,
      category: b.category,
      amount: serializeAmount(b.amount),
      spent: serializeAmount(spent),
      remaining: serializeAmount(b.amount.sub(spent)),
      utilizationPct: serializePercent(utilization),
      status: budgetStatus(utilization),
      currency: b.currency,
    };
  });

  const totalBudgeted = budgets.reduce((s, b) => s.add(b.amount), ZERO);
  const totalSpent = items.reduce((s, i) => s.add(i.spent), ZERO);

  return {
    period: { year: ym.year, month: ym.month },
    totals: {
      budgeted: serializeAmount(totalBudgeted),
      spent: serializeAmount(totalSpent),
      remaining: serializeAmount(totalBudgeted.sub(totalSpent)),
    },
    budgets: items,
  };
}

export async function upsertBudget(
  userId: string,
  categoryId: string,
  input: UpsertBudgetInput,
  timezone: string,
) {
  if (!(await isCategoryVisible(userId, categoryId))) throw AppError.notFound('Category');

  const ym = input.year && input.month ? { year: input.year, month: input.month } : currentYearMonth(timezone);
  const periodMonth = toPeriodMonth(ym.year, ym.month);
  const amount = new Decimal(input.amount);

  const budget = await prisma.budget.upsert({
    where: { userId_categoryId_periodMonth: { userId, categoryId, periodMonth } },
    create: { userId, categoryId, periodMonth, amount },
    update: { amount },
    select: { id: true, amount: true, currency: true },
  });
  return { ...budget, categoryId, amount: serializeAmount(budget.amount), period: ym };
}

export async function deleteBudget(
  userId: string,
  categoryId: string,
  timezone: string,
  year?: number,
  month?: number,
) {
  const ym = year && month ? { year, month } : currentYearMonth(timezone);
  const { count } = await prisma.budget.deleteMany({
    where: { userId, categoryId, periodMonth: toPeriodMonth(ym.year, ym.month) },
  });
  if (count === 0) throw AppError.notFound('Budget');
}
