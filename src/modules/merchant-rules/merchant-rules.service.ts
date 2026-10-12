// src/modules/merchant-rules/merchant-rules.service.ts
import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';
import { uuidSchema } from '../../shared/validation/pagination.schema';
import { escapeLike } from '../../shared/utils/sql';
import { isCategoryVisible } from '../categories/categories.service';

export const createRuleSchema = z.object({
  pattern: z.string().trim().min(2).max(100),
  categoryId: uuidSchema,
  normalizedName: z.string().trim().min(1).max(200).nullable().optional(),
  priority: z.number().int().min(-1000).max(1000).default(0),
});

export const updateRuleSchema = createRuleSchema.partial();

const RULE_SELECT = {
  id: true, pattern: true, categoryId: true, normalizedName: true, priority: true, createdAt: true,
} as const;

/** Rules in evaluation order: highest priority first, oldest first within a priority. */
export async function loadRules(userId: string) {
  return prisma.merchantRule.findMany({
    where: { userId },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    select: RULE_SELECT,
  });
}

export const listRules = loadRules;

async function assertCategory(userId: string, categoryId: string) {
  if (!(await isCategoryVisible(userId, categoryId))) throw AppError.notFound('Category');
}

export async function createRule(userId: string, input: z.infer<typeof createRuleSchema>) {
  await assertCategory(userId, input.categoryId);
  return prisma.merchantRule.create({
    data: {
      userId,
      pattern: input.pattern,
      categoryId: input.categoryId,
      normalizedName: input.normalizedName ?? null,
      priority: input.priority,
    },
    select: RULE_SELECT,
  });
}

async function findOwned(userId: string, id: string) {
  const rule = await prisma.merchantRule.findFirst({ where: { id, userId }, select: RULE_SELECT });
  if (!rule) throw AppError.notFound('Merchant rule');
  return rule;
}

export async function updateRule(userId: string, id: string, input: z.infer<typeof updateRuleSchema>) {
  await findOwned(userId, id);
  if (input.categoryId) await assertCategory(userId, input.categoryId);
  return prisma.merchantRule.update({
    where: { id },
    data: {
      ...(input.pattern !== undefined && { pattern: input.pattern }),
      ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      ...(input.normalizedName !== undefined && { normalizedName: input.normalizedName }),
      ...(input.priority !== undefined && { priority: input.priority }),
    },
    select: RULE_SELECT,
  });
}

export async function deleteRule(userId: string, id: string) {
  await findOwned(userId, id);
  await prisma.merchantRule.delete({ where: { id } });
}

/**
 * Re-applies one rule to existing transactions. Transactions the user has reviewed/corrected
 * (is_reviewed = true) are never overwritten - user corrections always win.
 */
export async function applyRule(userId: string, id: string) {
  const rule = await findOwned(userId, id);
  const result = await prisma.transaction.updateMany({
    where: {
      userId,
      isReviewed: false,
      description: { contains: escapeLike(rule.pattern), mode: 'insensitive' },
    },
    data: {
      categoryId: rule.categoryId,
      ...(rule.normalizedName && { merchantName: rule.normalizedName }),
    },
  });
  return { updated: result.count };
}
