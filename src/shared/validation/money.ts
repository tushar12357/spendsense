// src/shared/validation/money.ts
// Zod building blocks shared by request schemas. Money travels as a decimal STRING, never a float.

import { z } from 'zod';
import { isValidTimezone } from '../utils/date';

/** Non-negative amount with at most 2 fraction digits and a sane upper bound (fits DECIMAL(14,2)). */
export const moneyString = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Must be a decimal amount with at most 2 decimal places');

/** Strictly positive amount. */
export const positiveMoneyString = moneyString.refine((v) => Number(v) > 0, 'Amount must be greater than 0');

export const timezoneSchema = z.string().max(64).refine(isValidTimezone, 'Must be a valid IANA timezone');

export const isoDateTime = z.string().datetime({ offset: true });

export const yearMonthQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
}).refine((v) => (v.year === undefined) === (v.month === undefined), {
  message: 'year and month must be provided together',
});
