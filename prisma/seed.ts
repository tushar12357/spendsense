// prisma/seed.ts  -  run with:  npm run db:seed
// Always seeds the built-in categories (idempotent). With SEED_DEMO=true it also creates a demo
// user with three months of realistic data so the analytics endpoints have something to show.
// Refuses to create demo data in production.

import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { env } from '../src/config/env';
import { prisma, disconnectPrisma } from '../src/infrastructure/database/prisma';
import { ensureSystemCategories } from '../src/modules/categories/system-categories';
import { generateFingerprint } from '../src/shared/utils/fingerprint';
import { addMonths, currentYearMonth, zonedToUtc } from '../src/shared/utils/date';
import { Decimal } from '../src/shared/utils/decimal';

const DEMO_EMAIL = 'demo@spendsense.local';
const TZ = 'Asia/Kolkata';

async function seedDemo() {
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');

  if (await prisma.user.findUnique({ where: { email: DEMO_EMAIL } })) {
    console.log(`Demo user ${DEMO_EMAIL} already exists - skipping.`);
    return;
  }
  const user = await prisma.user.create({
    data: {
      email: DEMO_EMAIL,
      passwordHash: await bcrypt.hash('DemoPassw0rd!', env.BCRYPT_ROUNDS),
      displayName: 'Demo User',
      timezone: TZ,
    },
  });
  const account = await prisma.account.create({
    data: { userId: user.id, name: 'HDFC Savings', type: 'SAVINGS', openingBalance: new Decimal('50000') },
  });

  const cats = new Map((await prisma.category.findMany({ where: { isSystem: true } })).map((c) => [c.name, c.id]));
  const now = currentYearMonth(TZ);
  const rows: Array<{ day: number; monthsAgo: number; type: 'INCOME' | 'EXPENSE'; amount: string; desc: string; cat: string }> = [];
  for (const monthsAgo of [2, 1, 0]) {
    rows.push(
      { day: 1, monthsAgo, type: 'INCOME', amount: '85000.00', desc: 'SALARY CREDIT', cat: 'Salary' },
      { day: 3, monthsAgo, type: 'EXPENSE', amount: '25000.00', desc: 'RENT TRANSFER HOUSE OWNER', cat: 'Rent & Housing' },
      { day: 5, monthsAgo, type: 'EXPENSE', amount: '649.00', desc: 'NETFLIX SUBSCRIPTION', cat: 'Subscriptions' },
      { day: 8, monthsAgo, type: 'EXPENSE', amount: '3200.00', desc: 'BIGBASKET GROCERIES', cat: 'Groceries' },
      { day: 12, monthsAgo, type: 'EXPENSE', amount: '1450.50', desc: 'UPI SWIGGY', cat: 'Food & Dining' },
      { day: 18, monthsAgo, type: 'EXPENSE', amount: '2100.00', desc: 'ELECTRICITY BILL', cat: 'Utilities & Bills' },
    );
  }

  for (const r of rows) {
    const ym = addMonths(now, -r.monthsAgo);
    const localDate = `${ym.year}-${String(ym.month).padStart(2, '0')}-${String(r.day).padStart(2, '0')}`;
    await prisma.transaction.create({
      data: {
        id: randomUUID(),
        userId: user.id,
        accountId: account.id,
        categoryId: cats.get(r.cat) ?? null,
        type: r.type,
        amount: new Decimal(r.amount),
        occurredAt: zonedToUtc({ year: ym.year, month: ym.month, day: r.day, hour: 12 }, TZ),
        description: r.desc,
        isReviewed: true,
        fingerprint: generateFingerprint({ accountId: account.id, localDate, amount: r.amount, description: r.desc }),
      },
    });
  }

  await prisma.savingsGoal.create({
    data: { userId: user.id, name: 'Emergency fund', targetAmount: new Decimal('300000'), currentAmount: new Decimal('90000') },
  });
  console.log(`Demo user ready:  ${DEMO_EMAIL} / DemoPassw0rd!`);
}

async function main() {
  const inserted = await ensureSystemCategories();
  console.log(`System categories ensured (${inserted} new).`);
  if (process.env['SEED_DEMO'] === 'true') await seedDemo();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
