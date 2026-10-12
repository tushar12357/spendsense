// src/modules/accounts/accounts.service.ts
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';
import { Decimal, serializeAmount } from '../../shared/utils/decimal';
import { moneyString } from '../../shared/validation/money';

export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['SAVINGS', 'CURRENT', 'CREDIT_CARD', 'WALLET', 'CASH']),
  // INR only for now: dashboards sum amounts across accounts, which is only valid in one currency.
  currency: z.literal('INR').default('INR'),
  /** Balance BEFORE the first transaction in the ledger. See docs/financial-rules.md. */
  openingBalance: moneyString.default('0'),
});

export const updateAccountSchema = createAccountSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

const ACCOUNT_SELECT = {
  id: true, name: true, type: true, currency: true,
  openingBalance: true, isActive: true, createdAt: true, updatedAt: true,
} as const;

type AccountRow = Prisma.AccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

function serializeAccount(a: AccountRow, balance?: AccountBalance) {
  return {
    ...a,
    openingBalance: serializeAmount(a.openingBalance),
    ...(balance && {
      currentBalance: serializeAmount(balance.balance),
      balanceIsEstimate: balance.hasTransfers,
    }),
  };
}

export interface AccountBalance {
  accountId: string;
  balance: Decimal;
  /** TRANSFER rows have no stored direction, so they are excluded and the balance is an estimate. */
  hasTransfers: boolean;
}

/**
 * Ledger-derived balance per account: opening + income + refunds - expenses.
 * One grouped query instead of N+1.
 */
export async function getAccountBalances(userId: string): Promise<Map<string, AccountBalance>> {
  const rows = await prisma.$queryRaw<
    Array<{ account_id: string; net: Prisma.Decimal; transfers: bigint }>
  >`
    SELECT
      account_id::text AS account_id,
      COALESCE(SUM(CASE
        WHEN type IN ('INCOME', 'REFUND') THEN amount
        WHEN type = 'EXPENSE' THEN -amount
        ELSE 0 END), 0) AS net,
      COUNT(*) FILTER (WHERE type = 'TRANSFER') AS transfers
    FROM transactions
    WHERE user_id = ${userId}::uuid
    GROUP BY account_id
  `;
  const accounts = await prisma.account.findMany({ where: { userId }, select: { id: true, openingBalance: true } });
  const byAccount = new Map(rows.map((r) => [r.account_id, r]));
  return new Map(
    accounts.map((a) => {
      const r = byAccount.get(a.id);
      return [
        a.id,
        {
          accountId: a.id,
          balance: a.openingBalance.add(r?.net ?? 0),
          hasTransfers: r ? Number(r.transfers) > 0 : false,
        },
      ];
    }),
  );
}

export async function listAccounts(userId: string) {
  const [accounts, balances] = await Promise.all([
    prisma.account.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, select: ACCOUNT_SELECT }),
    getAccountBalances(userId),
  ]);
  return accounts.map((a) => serializeAccount(a, balances.get(a.id)));
}

async function findOwned(userId: string, accountId: string) {
  const account = await prisma.account.findFirst({ where: { id: accountId, userId }, select: ACCOUNT_SELECT });
  if (!account) throw AppError.notFound('Account');
  return account;
}

export async function getAccount(userId: string, accountId: string) {
  const account = await findOwned(userId, accountId);
  const balances = await getAccountBalances(userId);
  return serializeAccount(account, balances.get(accountId));
}

export async function createAccount(userId: string, input: CreateAccountInput) {
  const account = await prisma.account.create({
    data: {
      userId,
      name: input.name,
      type: input.type,
      currency: input.currency,
      openingBalance: new Decimal(input.openingBalance),
    },
    select: ACCOUNT_SELECT,
  });
  return serializeAccount(account);
}

export async function updateAccount(userId: string, accountId: string, input: UpdateAccountInput) {
  await findOwned(userId, accountId);
  const account = await prisma.account.update({
    where: { id: accountId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.type !== undefined && { type: input.type }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.openingBalance !== undefined && { openingBalance: new Decimal(input.openingBalance) }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
    select: ACCOUNT_SELECT,
  });
  return serializeAccount(account);
}

export async function deleteAccount(userId: string, accountId: string) {
  await findOwned(userId, accountId);
  const [transactions, imports] = await Promise.all([
    prisma.transaction.count({ where: { accountId, userId } }),
    prisma.importBatch.count({ where: { accountId, userId } }),
  ]);
  if (transactions > 0 || imports > 0) {
    throw AppError.conflict(
      'This account has transactions or import history and cannot be deleted. Deactivate it instead (PATCH isActive=false).',
    );
  }
  await prisma.account.delete({ where: { id: accountId } });
}
