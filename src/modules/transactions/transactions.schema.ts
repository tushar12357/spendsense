// src/modules/transactions/transactions.schema.ts
import { z } from 'zod';

export const createTransactionSchema = z.object({
  accountId: z.string().uuid(),
  type: z.enum(['INCOME', 'EXPENSE', 'TRANSFER', 'REFUND']),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).refine((v) => parseFloat(v) > 0, {
    message: 'Amount must be greater than 0',
  }),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  description: z.string().min(1).max(500).trim(),
  categoryId: z.string().uuid().optional(),
  merchantName: z.string().max(200).trim().optional(),
  notes: z.string().max(1000).trim().optional(),
  sourceTxId: z.string().max(200).trim().optional(),
  destinationAccountId: z.string().uuid().optional(),
});

export const transactionQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  type: z.enum(['INCOME', 'EXPENSE', 'TRANSFER', 'REFUND']).optional(),
  categoryId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
});

export const updateTransactionSchema = z.object({
  categoryId: z.string().uuid().nullable().optional(),
  merchantName: z.string().max(200).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  isReviewed: z.boolean().optional(),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type TransactionQuery = z.infer<typeof transactionQuerySchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
