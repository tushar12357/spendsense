// src/modules/transactions/transactions.schema.ts
import { z } from 'zod';
import { isoDateTime, positiveMoneyString } from '../../shared/validation/money';
import { uuidSchema } from '../../shared/validation/pagination.schema';

const transactionType = z.enum(['INCOME', 'EXPENSE', 'TRANSFER', 'REFUND']);

// Manual ledger entry. Amount is always positive; `type` carries the direction.
export const createTransactionSchema = z.object({
  accountId: uuidSchema,
  type: transactionType,
  amount: positiveMoneyString,
  categoryId: uuidSchema.optional(),
  description: z.string().trim().min(1).max(500),
  occurredAt: isoDateTime.optional(),
  merchantName: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const transactionQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    type: transactionType.optional(),
    categoryId: uuidSchema.optional(),
    accountId: uuidSchema.optional(),
    /** Case-insensitive search over description and merchant name. */
    q: z.string().trim().min(1).max(200).optional(),
    /** true -> only uncategorized transactions (inbox for corrections). */
    uncategorized: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) < new Date(q.to), {
    message: '`from` must be earlier than `to`',
    path: ['from'],
  });

export const updateTransactionSchema = z
  .object({
    categoryId: uuidSchema.nullable().optional(),
    merchantName: z.string().trim().max(200).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    isReviewed: z.boolean().optional(),
    /** Reclassify, e.g. an imported EXPENSE that was really a TRANSFER between own accounts. */
    type: transactionType.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type TransactionQuery = z.infer<typeof transactionQuerySchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
