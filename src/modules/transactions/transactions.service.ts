// src/modules/transactions/transactions.service.ts
// Transaction ledger: create (manual entry), list, get, update (corrections), delete.
// Every query is scoped to the authenticated user - cross-user access is impossible by construction.

import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';
import { decodeCursor, encodeCursor } from '../../shared/validation/pagination.schema';
import { Decimal, serializeAmount } from '../../shared/utils/decimal';
import { toLocalDate } from '../../shared/utils/date';
import { escapeLike } from '../../shared/utils/sql';
import { generateFingerprint } from '../../shared/utils/fingerprint';
import { getUserTimezone } from '../users/users.service';
import { isCategoryVisible } from '../categories/categories.service';
import type { CreateTransactionInput, TransactionQuery, UpdateTransactionInput } from './transactions.schema';

const TX_SELECT = {
  id: true,
  type: true,
  amount: true,
  currency: true,
  occurredAt: true,
  description: true,
  merchantName: true,
  notes: true,
  sourceTxId: true,
  isReviewed: true,
  importRowId: true,
  transferPeerId: true,
  createdAt: true,
  updatedAt: true,
  account: { select: { id: true, name: true, type: true } },
  category: { select: { id: true, name: true, icon: true, color: true } },
} satisfies Prisma.TransactionSelect;

type TxRow = Prisma.TransactionGetPayload<{ select: typeof TX_SELECT }>;

function serializeTx(tx: TxRow) {
  return { ...tx, amount: serializeAmount(tx.amount) };
}

export async function createTransaction(userId: string, input: CreateTransactionInput) {
  const account = await prisma.account.findFirst({
    where: { id: input.accountId, userId },
    select: { id: true, currency: true, isActive: true },
  });
  if (!account) throw AppError.notFound('Account');
  if (!account.isActive) throw AppError.badRequest('Cannot add entries to an inactive account');

  if (input.categoryId && !(await isCategoryVisible(userId, input.categoryId))) {
    throw AppError.notFound('Category');
  }

  const tz = await getUserTimezone(userId);
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const amount = new Decimal(input.amount);

  const created = await prisma.transaction.create({
    data: {
      userId,
      accountId: account.id,
      categoryId: input.categoryId ?? null,
      type: input.type,
      amount,
      currency: account.currency,
      occurredAt,
      description: input.description,
      merchantName: input.merchantName ?? null,
      notes: input.notes ?? null,
      fingerprint: generateFingerprint({
        accountId: account.id,
        localDate: toLocalDate(occurredAt, tz),
        amount: amount.toFixed(2),
        description: input.description,
      }),
      // The user categorized this at entry time, so it does not need review.
      isReviewed: input.categoryId !== undefined,
    },
    select: TX_SELECT,
  });

  return serializeTx(created);
}

export async function listTransactions(userId: string, query: TransactionQuery) {
  const { cursor, limit, from, to, type, categoryId, accountId, q, uncategorized } = query;

  // Each independent condition is an element of AND so none can overwrite another
  // (search and cursor both need OR groups).
  const and: Prisma.TransactionWhereInput[] = [];

  if (from || to) {
    and.push({ occurredAt: { ...(from && { gte: new Date(from) }), ...(to && { lt: new Date(to) }) } });
  }
  if (q) {
    and.push({
      OR: [
        { description: { contains: escapeLike(q), mode: 'insensitive' } },
        { merchantName: { contains: escapeLike(q), mode: 'insensitive' } },
      ],
    });
  }
  const whereWith = (...extra: Prisma.TransactionWhereInput[]): Prisma.TransactionWhereInput => ({
    userId,
    ...(type && { type }),
    ...(categoryId && { categoryId }),
    ...(uncategorized && { categoryId: null }),
    ...(accountId && { accountId }),
    AND: [...and, ...extra],
  });
  const orderBy: Prisma.TransactionOrderByWithRelationInput[] = [{ occurredAt: 'desc' }, { id: 'asc' }];

  // Fetch limit+1 to learn whether another page exists without a COUNT query.
  const want = limit + 1;
  let rows: TxRow[];

  if (!cursor) {
    rows = await prisma.transaction.findMany({ where: whereWith(), orderBy, take: want, select: TX_SELECT });
  } else {
    // Keyset pagination over the deterministic order (occurredAt DESC, id ASC).
    // The textbook predicate `occurredAt < X OR (occurredAt = X AND id > Y)` cannot be used as an
    // index range, so deep pages degrade into a scan (measured: ~300 ms at 200k rows). Splitting
    // it into two simple queries lets each use the (user_id, occurred_at) index directly.
    const c = decodeCursor(cursor);
    const ties = await prisma.transaction.findMany({
      where: whereWith({ occurredAt: c.occurredAt }, { id: { gt: c.id } }),
      orderBy: { id: 'asc' },
      take: want,
      select: TX_SELECT,
    });
    const older =
      ties.length >= want
        ? []
        : await prisma.transaction.findMany({
            where: whereWith({ occurredAt: { lt: c.occurredAt } }),
            orderBy,
            take: want - ties.length,
            select: TX_SELECT,
          });
    rows = [...ties, ...older];
  }

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];

  return {
    data: data.map(serializeTx),
    pagination: {
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last.id, last.occurredAt) : null,
      count: data.length,
    },
  };
}

export async function getTransaction(userId: string, id: string) {
  const tx = await prisma.transaction.findFirst({ where: { id, userId }, select: TX_SELECT });
  if (!tx) throw AppError.notFound('Transaction');
  return serializeTx(tx);
}

export async function updateTransaction(userId: string, id: string, input: UpdateTransactionInput) {
  const existing = await prisma.transaction.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw AppError.notFound('Transaction');

  if (input.categoryId && !(await isCategoryVisible(userId, input.categoryId))) {
    throw AppError.notFound('Category');
  }

  // A manual category/type correction marks the row reviewed so rules never overwrite it later.
  const touchesClassification = input.categoryId !== undefined || input.type !== undefined;

  const updated = await prisma.transaction.update({
    where: { id },
    data: {
      ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      ...(input.merchantName !== undefined && { merchantName: input.merchantName }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.type !== undefined && { type: input.type }),
      ...((input.isReviewed !== undefined || touchesClassification) && {
        isReviewed: input.isReviewed ?? true,
      }),
    },
    select: TX_SELECT,
  });

  return serializeTx(updated);
}

/**
 * Hard-deletes a transaction. Import history stays reconcilable: the originating import row is
 * kept (status ACCEPTED, transaction_id NULL) with an explanatory reason.
 */
export async function deleteTransaction(userId: string, id: string) {
  const existing = await prisma.transaction.findFirst({
    where: { id, userId },
    select: { id: true, importRowId: true },
  });
  if (!existing) throw AppError.notFound('Transaction');

  await prisma.$transaction(async (tx) => {
    if (existing.importRowId) {
      await tx.importRow.update({
        where: { id: existing.importRowId },
        data: { transactionId: null, reason: 'Transaction deleted by user after import' },
      });
    }
    await tx.transaction.updateMany({ where: { userId, transferPeerId: id }, data: { transferPeerId: null } });
    await tx.transaction.delete({ where: { id } });
  });
}
