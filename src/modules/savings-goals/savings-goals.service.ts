// src/modules/savings-goals/savings-goals.service.ts
import { z } from 'zod';
import type { GoalStatus, Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';
import { Decimal, ZERO, percentOf, serializeAmount, serializePercent } from '../../shared/utils/decimal';
import { currentYearMonth, monthsBetween } from '../../shared/utils/date';
import { moneyString, positiveMoneyString } from '../../shared/validation/money';
import { requiredMonthlySaving } from '../analytics/finance';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const createGoalSchema = z.object({
  name: z.string().trim().min(1).max(200),
  targetAmount: positiveMoneyString,
  currentAmount: moneyString.default('0'),
  targetDate: dateOnly.optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const updateGoalSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    targetAmount: positiveMoneyString,
    currentAmount: moneyString,
    targetDate: dateOnly.nullable(),
    notes: z.string().trim().max(1000).nullable(),
    status: z.enum(['ACTIVE', 'ACHIEVED', 'PAUSED', 'CANCELLED']),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;

const GOAL_SELECT = {
  id: true, name: true, targetAmount: true, currentAmount: true,
  currency: true, targetDate: true, status: true, notes: true,
  createdAt: true, updatedAt: true,
} satisfies Prisma.SavingsGoalSelect;

type GoalRow = Prisma.SavingsGoalGetPayload<{ select: typeof GOAL_SELECT }>;

/** Remaining amount, completion %, and the monthly contribution needed to hit the target date. */
export function describeGoal(g: GoalRow, timezone: string, now: Date = new Date()) {
  const remaining = Decimal.max(g.targetAmount.sub(g.currentAmount), ZERO);
  const today = currentYearMonth(timezone, now);

  let monthsLeft: number | null = null;
  let isOverdue = false;
  if (g.targetDate) {
    const target = { year: g.targetDate.getUTCFullYear(), month: g.targetDate.getUTCMonth() + 1 };
    monthsLeft = monthsBetween(today, target) + 1; // the current month counts
    isOverdue = target.year * 12 + target.month < today.year * 12 + today.month && remaining.greaterThan(0);
  }
  const monthly = g.status === 'ACTIVE' ? requiredMonthlySaving(remaining, monthsLeft) : null;

  return {
    ...g,
    targetAmount: serializeAmount(g.targetAmount),
    currentAmount: serializeAmount(g.currentAmount),
    targetDate: g.targetDate ? g.targetDate.toISOString().slice(0, 10) : null,
    remaining: serializeAmount(remaining),
    progressPct: serializePercent(percentOf(g.currentAmount, g.targetAmount)),
    monthsLeft,
    isOverdue,
    requiredMonthlySaving: monthly === null ? null : serializeAmount(monthly),
  };
}

export async function listGoals(userId: string, timezone: string) {
  const goals = await prisma.savingsGoal.findMany({
    where: { userId },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    select: GOAL_SELECT,
  });
  return goals.map((g) => describeGoal(g, timezone));
}

/** A goal that has reached its target is marked ACHIEVED automatically (unless paused/cancelled). */
function autoStatus(status: GoalStatus, current: Decimal, target: Decimal): GoalStatus {
  return status === 'ACTIVE' && current.greaterThanOrEqualTo(target) ? 'ACHIEVED' : status;
}

export async function createGoal(userId: string, input: CreateGoalInput, timezone: string) {
  const target = new Decimal(input.targetAmount);
  const current = new Decimal(input.currentAmount);
  const goal = await prisma.savingsGoal.create({
    data: {
      userId,
      name: input.name,
      targetAmount: target,
      currentAmount: current,
      status: autoStatus('ACTIVE', current, target),
      targetDate: input.targetDate ? new Date(`${input.targetDate}T00:00:00Z`) : null,
      notes: input.notes ?? null,
    },
    select: GOAL_SELECT,
  });
  return describeGoal(goal, timezone);
}

export async function updateGoal(userId: string, goalId: string, input: UpdateGoalInput, timezone: string) {
  const existing = await prisma.savingsGoal.findFirst({ where: { id: goalId, userId }, select: GOAL_SELECT });
  if (!existing) throw AppError.notFound('Savings goal');

  const target = input.targetAmount !== undefined ? new Decimal(input.targetAmount) : existing.targetAmount;
  const current = input.currentAmount !== undefined ? new Decimal(input.currentAmount) : existing.currentAmount;
  const status = autoStatus(input.status ?? existing.status, current, target);

  const updated = await prisma.savingsGoal.update({
    where: { id: goalId },
    data: {
      targetAmount: target,
      currentAmount: current,
      status,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.targetDate !== undefined && {
        targetDate: input.targetDate ? new Date(`${input.targetDate}T00:00:00Z`) : null,
      }),
      ...(input.notes !== undefined && { notes: input.notes }),
    },
    select: GOAL_SELECT,
  });
  return describeGoal(updated, timezone);
}

export async function deleteGoal(userId: string, goalId: string) {
  const { count } = await prisma.savingsGoal.deleteMany({ where: { id: goalId, userId } });
  if (count === 0) throw AppError.notFound('Savings goal');
}
