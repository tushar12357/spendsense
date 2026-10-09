// src/modules/savings-goals/savings-goals.service.ts
import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';
import { Decimal, serializeAmount } from '../../shared/utils/decimal';

export const createGoalSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  targetAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).refine((v) => parseFloat(v) > 0),
  currentAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).default('0'),
  targetDate: z.string().datetime({ offset: true }).optional(),
  notes: z.string().max(1000).optional(),
});

export const updateGoalSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  targetAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  currentAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  targetDate: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  status: z.enum(['ACTIVE', 'ACHIEVED', 'PAUSED', 'CANCELLED']).optional(),
});

export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;

function serializeGoal(g: {
  id: string;
  name: string;
  targetAmount: Decimal;
  currentAmount: Decimal;
  currency: string;
  targetDate: Date | null;
  status: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const progressPct = g.targetAmount.isZero()
    ? null
    : g.currentAmount.div(g.targetAmount).mul(100);
  return {
    ...g,
    targetAmount: serializeAmount(g.targetAmount),
    currentAmount: serializeAmount(g.currentAmount),
    progressPct: progressPct ? serializeAmount(progressPct) : null,
  };
}

const GOAL_SELECT = {
  id: true, name: true, targetAmount: true, currentAmount: true,
  currency: true, targetDate: true, status: true, notes: true,
  createdAt: true, updatedAt: true,
} as const;

export async function listGoals(userId: string) {
  const goals = await prisma.savingsGoal.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: GOAL_SELECT,
  });
  return goals.map(serializeGoal);
}

export async function createGoal(userId: string, input: CreateGoalInput) {
  const goal = await prisma.savingsGoal.create({
    data: {
      userId,
      name: input.name,
      targetAmount: new Decimal(input.targetAmount),
      currentAmount: new Decimal(input.currentAmount),
      targetDate: input.targetDate ? new Date(input.targetDate) : undefined,
      notes: input.notes,
    },
    select: GOAL_SELECT,
  });
  return serializeGoal(goal);
}

export async function updateGoal(userId: string, goalId: string, input: UpdateGoalInput) {
  const existing = await prisma.savingsGoal.findFirst({
    where: { id: goalId, userId }, select: { id: true },
  });
  if (!existing) throw AppError.notFound('Savings goal');

  const updated = await prisma.savingsGoal.update({
    where: { id: goalId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.targetAmount !== undefined && { targetAmount: new Decimal(input.targetAmount) }),
      ...(input.currentAmount !== undefined && { currentAmount: new Decimal(input.currentAmount) }),
      ...(input.targetDate !== undefined && { targetDate: input.targetDate ? new Date(input.targetDate) : null }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.status !== undefined && { status: input.status }),
    },
    select: GOAL_SELECT,
  });
  return serializeGoal(updated);
}

export async function deleteGoal(userId: string, goalId: string) {
  const existing = await prisma.savingsGoal.findFirst({
    where: { id: goalId, userId }, select: { id: true },
  });
  if (!existing) throw AppError.notFound('Savings goal');
  await prisma.savingsGoal.delete({ where: { id: goalId } });
}
