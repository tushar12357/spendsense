// src/modules/imports/imports.schema.ts
import { z } from 'zod';

export const importQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const importRowQuerySchema = z.object({
  status: z.enum(['ACCEPTED', 'DUPLICATE', 'SKIPPED', 'REJECTED']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const uploadSchema = z.object({
  accountId: z.string().uuid(),
  adapterKey: z.string().min(1),
});

export type UploadInput = z.infer<typeof uploadSchema>;
