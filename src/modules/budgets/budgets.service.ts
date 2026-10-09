// src/modules/budgets/budgets.service.ts
import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';
import { Decimal, serializeAmount } from '../../shared/utils/decimal';
import { monthBoundaries, currentYearMonth, toPeriodMonth } from '../../shared/utils/date';

export const upsertBudgetSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).refine((v) => parseFloat(v) > 0),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

export type UpsertBudgetInput = z.infer<typeof upsertBudgetSchema>;

export async function listBudgets(userId: string, userTimezone: string) {
  const { year, month } = currentYearMonth(userTimezone);
  const { from, to } = monthBoundaries(year, month, userTimezone);
  const periodMonth = toPeriodMonth(year, month);

  const budgets = await prisma.budget.findMany({
    where: { userId, periodMonth },
    select: {
      id: true, amount: true, currency: true,
      category: { select: { id: true, name: true, icon: true, color: true } },
    },
  });

  // Compute utilization for each budget in a single aggregation query
  const spentRows = await prisma.$queryRaw<Array<{ category_id: string; spent: Decimal }>>`
    SELECT category_id::text, COALESCE(SUM(
      CASE WHEN type = 'REFUND' THEN -amount ELSE amount END
    ), 0) AS spent
    FROM transactions
    WHERE user_id = ${userId}::uuid
      AND type IN ('EXPENSE', 'REFUND')
      AND occurred_at >= ${from}
      AND occurred_at <  ${to}
      AND category_id = ANY(${budgets.map((b) => b.category.id)}::uuid[])
    GROUP BY category_id
  `;

  const spentMap = new Map(spentRows.map((r) => [r.category_id, new Decimal(r.spent)]));

  return budgets.map((b) => {
    const spent = spentMap.get(b.category.id) ?? new Decimal(0);
    const remaining = b.amount.sub(spent);
    const utilization = b.amount.isZero() ? null : spent.div(b.amount).mul(100);
    return {
      id: b.id,
      category: b.category,
      amount: serializeAmount(b.amount),
      spent: serializeAmount(spent),
      remaining: serializeAmount(remaining),
      utilizationPct: utilization ? serializeAmount(utilization) : null,
      currency: b.currency,
      period: { year, month },
    };
  });
}

export async function upsertBudget(
  userId: string,
  categoryId: string,
  input: UpsertBudgetInput,
  userTimezone: string,
) {
  // Verify category access
  const cat = await prisma.category.findFirst({
    where: { id: categoryId, OR: [{ userId }, { isSystem: true }] },
  });
  if (!cat) throw AppError.notFound('Category');

  const ym = input.year && input.month
    ? { year: input.year, month: input.month }
    : currentYearMonth(userTimezone);
  const periodMonth = toPeriodMonth(ym.year, ym.month);

  return prisma.budget.upsert({
    where: { userId_categoryId_periodMonth: { userId, categoryId, periodMonth } },
    create: { userId, categoryId, periodMonth, amount: new Decimal(input.amount) },
    update: { amount: new Decimal(input.amount) },
    select: { id: true, amount: true, currency: true, periodMonth: true },
  });
}
