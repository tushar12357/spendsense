// src/modules/categories/categories.service.ts
import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';

export const createCategorySchema = z.object({
  name: z.string().min(1).max(100).trim(),
  parentId: z.string().uuid().optional(),
  icon: z.string().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

export const updateCategorySchema = createCategorySchema.partial();

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

/** Returns system categories + user's own categories */
export async function listCategories(userId: string) {
  return prisma.category.findMany({
    where: { OR: [{ userId }, { isSystem: true }] },
    orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    select: {
      id: true, name: true, parentId: true, icon: true,
      color: true, isSystem: true, userId: true,
    },
  });
}

export async function createCategory(userId: string, input: CreateCategoryInput) {
  if (input.parentId) {
    const parent = await prisma.category.findFirst({
      where: { id: input.parentId, OR: [{ userId }, { isSystem: true }] },
    });
    if (!parent) throw AppError.notFound('Parent category');
  }
  return prisma.category.create({
    data: { userId, name: input.name, parentId: input.parentId, icon: input.icon, color: input.color },
    select: { id: true, name: true, parentId: true, icon: true, color: true, isSystem: true },
  });
}

async function assertOwnership(userId: string, categoryId: string) {
  const cat = await prisma.category.findFirst({ where: { id: categoryId, userId } });
  if (!cat) throw AppError.notFound('Category');
  return cat;
}

export async function updateCategory(userId: string, categoryId: string, input: UpdateCategoryInput) {
  await assertOwnership(userId, categoryId);
  return prisma.category.update({
    where: { id: categoryId },
    data: input,
    select: { id: true, name: true, parentId: true, icon: true, color: true },
  });
}

export async function deleteCategory(userId: string, categoryId: string) {
  await assertOwnership(userId, categoryId);
  await prisma.category.delete({ where: { id: categoryId } });
}
