// src/modules/auth/auth.schema.ts
import { z } from 'zod';
import { timezoneSchema } from '../../shared/validation/money';

const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and digits');

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const registerSchema = z.object({
  email,
  password,
  displayName: z.string().trim().min(1).max(100),
  timezone: timezoneSchema.default('Asia/Kolkata'),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: password,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
