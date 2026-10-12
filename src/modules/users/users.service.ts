// src/modules/users/users.service.ts
// Profile, data export and account deletion.

import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';
import { serializeAmount } from '../../shared/utils/decimal';
import { timezoneSchema } from '../../shared/validation/money';

const PROFILE_SELECT = { id: true, email: true, displayName: true, timezone: true, createdAt: true } as const;

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  timezone: timezoneSchema.optional(),
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1).max(128),
});

export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: PROFILE_SELECT });
  if (!user) throw AppError.notFound('User');
  return user;
}

/** Timezone used for every reporting-period calculation. Falls back to IST for unknown users. */
export async function getUserTimezone(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  return user?.timezone ?? 'Asia/Kolkata';
}

export async function updateProfile(userId: string, input: z.infer<typeof updateProfileSchema>) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.displayName !== undefined && { displayName: input.displayName }),
      ...(input.timezone !== undefined && { timezone: input.timezone }),
    },
    select: PROFILE_SELECT,
  });
}

/**
 * Full export of the user's data (portability). Import `rawData` is included because it is the
 * user's own statement content; it is deliberately absent from every other API response.
 */
export async function exportUserData(userId: string) {
  const [user, accounts, categories, merchantRules, transactions, batches, budgets, goals] =
    await Promise.all([
      getProfile(userId),
      prisma.account.findMany({ where: { userId } }),
      prisma.category.findMany({ where: { userId } }),
      prisma.merchantRule.findMany({ where: { userId } }),
      prisma.transaction.findMany({ where: { userId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] }),
      prisma.importBatch.findMany({ where: { userId }, include: { rows: true }, orderBy: { createdAt: 'asc' } }),
      prisma.budget.findMany({ where: { userId } }),
      prisma.savingsGoal.findMany({ where: { userId } }),
    ]);

  return {
    exportedAt: new Date().toISOString(),
    user,
    accounts: accounts.map((a) => ({ ...a, openingBalance: serializeAmount(a.openingBalance) })),
    categories,
    merchantRules,
    transactions: transactions.map((t) => ({ ...t, amount: serializeAmount(t.amount) })),
    importBatches: batches,
    budgets: budgets.map((b) => ({ ...b, amount: serializeAmount(b.amount) })),
    savingsGoals: goals.map((g) => ({
      ...g,
      targetAmount: serializeAmount(g.targetAmount),
      currentAmount: serializeAmount(g.currentAmount),
    })),
  };
}

/**
 * Permanently deletes the user and everything they own. Requires the password again.
 * Rows are removed child-first inside one transaction because several foreign keys are
 * ON DELETE RESTRICT (accounts <- transactions, categories <- transactions).
 */
export async function deleteAccount(userId: string, password: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user) throw AppError.notFound('User');
  if (!(await bcrypt.compare(password, user.passwordHash))) throw AppError.invalidCredentials();

  await prisma.$transaction(
    async (tx) => {
      await tx.transaction.updateMany({ where: { userId }, data: { transferPeerId: null, importRowId: null } });
      await tx.importRow.updateMany({ where: { batch: { userId } }, data: { transactionId: null } });
      await tx.transaction.deleteMany({ where: { userId } });
      await tx.importRow.deleteMany({ where: { batch: { userId } } });
      await tx.importBatch.deleteMany({ where: { userId } });
      await tx.budget.deleteMany({ where: { userId } });
      await tx.merchantRule.deleteMany({ where: { userId } });
      await tx.savingsGoal.deleteMany({ where: { userId } });
      await tx.account.deleteMany({ where: { userId } });
      await tx.category.updateMany({ where: { userId }, data: { parentId: null } });
      await tx.category.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
    },
    { timeout: 60_000 },
  );
}
