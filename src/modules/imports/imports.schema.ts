// src/modules/imports/imports.schema.ts
import { z } from 'zod';
import { uuidSchema } from '../../shared/validation/pagination.schema';

export const importQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const importRowQuerySchema = z.object({
  status: z.enum(['ACCEPTED', 'DUPLICATE', 'SKIPPED', 'REJECTED']).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const uploadSchema = z.object({
  accountId: uuidSchema,
  /** Optional: omit to auto-detect the bank format from the CSV header row. */
  adapterKey: z.string().trim().min(1).max(50).optional(),
});

export type UploadInput = z.infer<typeof uploadSchema>;
