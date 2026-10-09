// src/modules/accounts/accounts.service.ts
import { Decimal } from '../../shared/utils/decimal';
import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';

export const createAccountSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  type: z.enum(['SAVINGS', 'CURRENT', 'CREDIT_CARD', 'WALLET', 'CASH']),
  currency: z.string().length(3).default('INR'),
  openingBalance: z.string().regex(/^\d+(\.\d{1,2})?$/).default('0'),
});

export const updateAccountSchema = createAccountSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export async function listAccounts(userId: string) {
  return prisma.account.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, name: true, type: true, currency: true,
      openingBalance: true, isActive: true, createdAt: true,
    },
  });
}

export async function getAccount(userId: string, accountId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, userId },
    select: {
      id: true, name: true, type: true, currency: true,
      openingBalance: true, isActive: true, createdAt: true, updatedAt: true,
    },
  });
  if (!account) throw AppError.notFound('Account');
  return account;
}

export async function createAccount(userId: string, input: CreateAccountInput) {
  return prisma.account.create({
    data: {
      userId,
      name: input.name,
      type: input.type,
      currency: input.currency,
      openingBalance: new Decimal(input.openingBalance),
    },
    select: {
      id: true, name: true, type: true, currency: true,
      openingBalance: true, isActive: true, createdAt: true,
    },
  });
}

export async function updateAccount(userId: string, accountId: string, input: UpdateAccountInput) {
  await getAccount(userId, accountId); // ownership check
  return prisma.account.update({
    where: { id: accountId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.type !== undefined && { type: input.type }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.openingBalance !== undefined && { openingBalance: new Decimal(input.openingBalance) }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
    select: {
      id: true, name: true, type: true, currency: true,
      openingBalance: true, isActive: true, updatedAt: true,
    },
  });
}

export async function deleteAccount(userId: string, accountId: string) {
  await getAccount(userId, accountId); // ownership check
  await prisma.account.delete({ where: { id: accountId } });
}
