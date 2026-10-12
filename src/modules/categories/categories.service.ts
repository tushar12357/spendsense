// src/modules/categories/categories.service.ts
import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';
import { uuidSchema } from '../../shared/validation/pagination.schema';

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  parentId: uuidSchema.nullable().optional(),
  icon: z.string().max(50).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

export const updateCategorySchema = createCategorySchema.partial();

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

const CATEGORY_SELECT = {
  id: true, name: true, parentId: true, icon: true, color: true, isSystem: true,
} as const;

/** System categories plus the user's own. */
export async function listCategories(userId: string) {
  return prisma.category.findMany({
    where: { OR: [{ userId }, { isSystem: true }] },
    orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    select: CATEGORY_SELECT,
  });
}

/** Parents must be visible to the user and top-level (the hierarchy is two levels deep). */
async function assertValidParent(userId: string, parentId: string, selfId?: string) {
  if (parentId === selfId) throw AppError.badRequest('A category cannot be its own parent');
  const parent = await prisma.category.findFirst({
    where: { id: parentId, OR: [{ userId }, { isSystem: true }] },
    select: { parentId: true },
  });
  if (!parent) throw AppError.notFound('Parent category');
  if (parent.parentId) throw AppError.badRequest('Categories can be nested only one level deep');
  if (selfId) {
    const children = await prisma.category.count({ where: { parentId: selfId } });
    if (children > 0) throw AppError.badRequest('A category that has sub-categories cannot become a sub-category');
  }
}

export async function createCategory(userId: string, input: CreateCategoryInput) {
  if (input.parentId) await assertValidParent(userId, input.parentId);
  return prisma.category.create({
    data: { userId, name: input.name, parentId: input.parentId ?? null, icon: input.icon, color: input.color },
    select: CATEGORY_SELECT,
  });
}

async function assertOwned(userId: string, categoryId: string) {
  // System categories are shared and immutable, so they are intentionally "not found" here.
  const cat = await prisma.category.findFirst({ where: { id: categoryId, userId }, select: { id: true } });
  if (!cat) throw AppError.notFound('Category');
}

export async function updateCategory(userId: string, categoryId: string, input: UpdateCategoryInput) {
  await assertOwned(userId, categoryId);
  if (input.parentId) await assertValidParent(userId, input.parentId, categoryId);
  return prisma.category.update({
    where: { id: categoryId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.parentId !== undefined && { parentId: input.parentId }),
      ...(input.icon !== undefined && { icon: input.icon }),
      ...(input.color !== undefined && { color: input.color }),
    },
    select: CATEGORY_SELECT,
  });
}

/**
 * Deleting a category never deletes ledger history: its transactions become uncategorized,
 * its sub-categories are promoted, and rules/budgets that pointed at it are removed.
 */
export async function deleteCategory(userId: string, categoryId: string) {
  await assertOwned(userId, categoryId);
  await prisma.$transaction(async (tx) => {
    await tx.transaction.updateMany({ where: { userId, categoryId }, data: { categoryId: null } });
    await tx.merchantRule.deleteMany({ where: { userId, categoryId } });
    await tx.budget.deleteMany({ where: { userId, categoryId } });
    await tx.category.updateMany({ where: { parentId: categoryId }, data: { parentId: null } });
    await tx.category.delete({ where: { id: categoryId } });
  });
}

/** True if the category is visible to the user (own or system). Used by other modules. */
export async function isCategoryVisible(userId: string, categoryId: string): Promise<boolean> {
  const count = await prisma.category.count({
    where: { id: categoryId, OR: [{ userId }, { isSystem: true }] },
  });
  return count > 0;
}
