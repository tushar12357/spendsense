// src/modules/transactions/transactions.service.ts
// Transaction ledger: list, get, update, delete.
// All queries are scoped to the authenticated user — cross-user access is impossible.

import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';
import { decodeCursor, encodeCursor } from '../../shared/validation/pagination.schema';
import { Decimal, serializeAmount } from '../../shared/utils/decimal';
import type { TransactionQuery, UpdateTransactionInput } from './transactions.schema';

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
  createdAt: true,
  updatedAt: true,
  account: { select: { id: true, name: true, type: true } },
  category: { select: { id: true, name: true, icon: true, color: true } },
} as const;

function serializeTx(tx: {
  id: string;
  type: string;
  amount: Decimal;
  currency: string;
  occurredAt: Date;
  description: string;
  merchantName: string | null;
  notes: string | null;
  sourceTxId: string | null;
  isReviewed: boolean;
  createdAt: Date;
  updatedAt: Date;
  account: { id: string; name: string; type: string };
  category: { id: string; name: string; icon: string | null; color: string | null } | null;
}) {
  return {
    ...tx,
    amount: serializeAmount(tx.amount),
  };
}

export async function listTransactions(userId: string, query: TransactionQuery) {
  const { cursor, limit, from, to, type, categoryId, accountId, q } = query;

  // Build where clause — always scoped to userId
  const where: Prisma.TransactionWhereInput = {
    userId,
    ...(type && { type }),
    ...(categoryId && { categoryId }),
    ...(accountId && { accountId }),
    ...(from || to
      ? {
          occurredAt: {
            ...(from && { gte: new Date(from) }),
            ...(to && { lt: new Date(to) }),
          },
        }
      : {}),
    ...(q && {
      OR: [
        { description: { contains: q, mode: 'insensitive' } },
        { merchantName: { contains: q, mode: 'insensitive' } },
      ],
    }),
  };

  // Cursor pagination: (occurredAt DESC, id ASC) — deterministic
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) throw AppError.badRequest('Invalid cursor');
    where.OR = [
      { occurredAt: { lt: decoded.occurredAt } },
      { occurredAt: decoded.occurredAt, id: { gt: decoded.id } },
    ];
  }

  // Fetch limit+1 to detect if there are more pages
  const rows = await prisma.transaction.findMany({
    where,
    orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
    take: limit + 1,
    select: TX_SELECT,
  });

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.id, last.occurredAt) : null;

  return {
    data: data.map(serializeTx),
    pagination: { hasMore, nextCursor, count: data.length },
  };
}

export async function getTransaction(userId: string, id: string) {
  const tx = await prisma.transaction.findFirst({
    where: { id, userId },
    select: TX_SELECT,
  });
  if (!tx) throw AppError.notFound('Transaction');
  return serializeTx(tx);
}

export async function updateTransaction(
  userId: string,
  id: string,
  input: UpdateTransactionInput,
) {
  // Verify ownership
  const existing = await prisma.transaction.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw AppError.notFound('Transaction');

  // If categoryId is being set, verify it belongs to this user or is a system category
  if (input.categoryId) {
    const cat = await prisma.category.findFirst({
      where: { id: input.categoryId, OR: [{ userId }, { isSystem: true }] },
    });
    if (!cat) throw AppError.notFound('Category');
  }

  const updated = await prisma.transaction.update({
    where: { id },
    data: {
      ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      ...(input.merchantName !== undefined && { merchantName: input.merchantName }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.isReviewed !== undefined && { isReviewed: input.isReviewed }),
    },
    select: TX_SELECT,
  });

  return serializeTx(updated);
}

export async function deleteTransaction(userId: string, id: string) {
  const existing = await prisma.transaction.findFirst({
    where: { id, userId },
    select: { id: true, importRowId: true },
  });
  if (!existing) throw AppError.notFound('Transaction');

  // Delete the transaction. Import row retains the record with transaction_id = null
  // so import history is preserved for reconciliation.
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Unlink from import row first (set transaction_id to null on the row)
    if (existing.importRowId) {
      await tx.importRow.update({
        where: { id: existing.importRowId },
        data: { transactionId: null },
      });
    }
    await tx.transaction.delete({ where: { id } });
  });
}
