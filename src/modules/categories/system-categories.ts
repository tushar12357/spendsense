// src/modules/categories/system-categories.ts
// Built-in categories visible to every user (categories.user_id IS NULL, is_system = true).
// Seeding is idempotent: backed by the partial unique index categories_system_name_key.

import { prisma } from '../../infrastructure/database/prisma';

export const SYSTEM_CATEGORIES: ReadonlyArray<{ name: string; icon: string; color: string }> = [
  { name: 'Salary', icon: 'briefcase', color: '#16A34A' },
  { name: 'Other Income', icon: 'plus-circle', color: '#22C55E' },
  { name: 'Rent & Housing', icon: 'home', color: '#7C3AED' },
  { name: 'Groceries', icon: 'shopping-cart', color: '#EA580C' },
  { name: 'Food & Dining', icon: 'utensils', color: '#F97316' },
  { name: 'Transport', icon: 'car', color: '#0EA5E9' },
  { name: 'Utilities & Bills', icon: 'zap', color: '#EAB308' },
  { name: 'Subscriptions', icon: 'repeat', color: '#6366F1' },
  { name: 'Shopping', icon: 'shopping-bag', color: '#EC4899' },
  { name: 'Health', icon: 'heart-pulse', color: '#EF4444' },
  { name: 'Entertainment', icon: 'film', color: '#A855F7' },
  { name: 'Travel', icon: 'plane', color: '#14B8A6' },
  { name: 'Education', icon: 'graduation-cap', color: '#3B82F6' },
  { name: 'Investments & Savings', icon: 'piggy-bank', color: '#059669' },
  { name: 'Cash Withdrawal', icon: 'banknote', color: '#78716C' },
  { name: 'Fees & Charges', icon: 'receipt', color: '#64748B' },
  { name: 'Transfers', icon: 'arrow-left-right', color: '#94A3B8' },
  { name: 'Other', icon: 'circle', color: '#9CA3AF' },
];

/** Inserts any missing system categories. Safe to call on every boot and from the seed script. */
export async function ensureSystemCategories(): Promise<number> {
  const result = await prisma.$executeRaw`
    INSERT INTO categories (id, name, icon, color, is_system, user_id, created_at)
    SELECT gen_random_uuid(), v.name, v.icon, v.color, true, NULL, now()
    FROM unnest(${SYSTEM_CATEGORIES.map((c) => c.name)}::text[], ${SYSTEM_CATEGORIES.map((c) => c.icon)}::text[], ${SYSTEM_CATEGORIES.map((c) => c.color)}::text[])
      AS v(name, icon, color)
    ON CONFLICT (name) WHERE user_id IS NULL DO NOTHING
  `;
  return result;
}
