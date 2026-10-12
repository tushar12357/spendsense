// Integration-test database helpers.
import { prisma } from '../../src/infrastructure/database/prisma';
import { ensureSystemCategories } from '../../src/modules/categories/system-categories';

/** Empties every table, then restores the built-in categories. Call in beforeEach. */
export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE import_rows, import_batches, transactions, budgets, merchant_rules, savings_goals, accounts, categories, users RESTART IDENTITY CASCADE',
  );
  await ensureSystemCategories();
}

export async function systemCategoryId(name: string): Promise<string> {
  const c = await prisma.category.findFirstOrThrow({ where: { isSystem: true, name } });
  return c.id;
}
