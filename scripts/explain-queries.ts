// scripts/explain-queries.ts  -  query-plan analysis for the dashboard / ledger queries.
//
//   npm run db:explain                 # uses DATABASE_URL (a DEV database - never point at production)
//   PERF_ROWS=500000 npm run db:explain
//
// Loads synthetic data once (a "perf" user with PERF_ROWS transactions over ~2 years plus 20 other
// users as background noise), runs ANALYZE, then prints EXPLAIN (ANALYZE, BUFFERS) for each
// representative query. Findings are summarised in docs/performance.md.

import { env } from '../src/config/env';
import { prisma, disconnectPrisma } from '../src/infrastructure/database/prisma';

const ROWS = Number(process.env['PERF_ROWS'] ?? 200_000);
const PERF_EMAIL = 'perf@spendsense.local';

async function ensureData(): Promise<{ userId: string; accountId: string }> {
  if (env.NODE_ENV === 'production') throw new Error('Refusing to run in production');
  const existing = await prisma.user.findUnique({ where: { email: PERF_EMAIL } });
  if (existing) {
    const account = await prisma.account.findFirstOrThrow({ where: { userId: existing.id } });
    return { userId: existing.id, accountId: account.id };
  }

  console.log(`Generating ${ROWS} rows for the perf user (+ ${ROWS * 2} noise rows)...`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO users (id, email, password_hash, display_name, updated_at)
    SELECT gen_random_uuid(), CASE WHEN g = 0 THEN '${PERF_EMAIL}' ELSE 'noise' || g || '@spendsense.local' END, 'x', 'u' || g, now()
    FROM generate_series(0, 20) g`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO accounts (id, user_id, name, type, updated_at)
    SELECT gen_random_uuid(), id, 'Main', 'SAVINGS', now() FROM users WHERE email LIKE '%@spendsense.local'`);

  // Perf user: ROWS rows. Noise users: 2 x ROWS rows split between them.
  await prisma.$executeRawUnsafe(`
    INSERT INTO transactions (id, user_id, account_id, category_id, type, amount, occurred_at, description, fingerprint, source_tx_id, updated_at)
    SELECT gen_random_uuid(), u.id, a.id,
           (SELECT id FROM categories WHERE is_system ORDER BY name OFFSET (g % 16) LIMIT 1),
           (ARRAY['EXPENSE','EXPENSE','EXPENSE','EXPENSE','INCOME','REFUND','TRANSFER'])[1 + (g % 7)]::"TransactionType",
           round((random() * 5000 + 1)::numeric, 2),
           now() - (random() * interval '730 days'),
           'UPI-MERCHANT ' || (g % 400) || ' REF' || g,
           md5(g::text), 'REF' || g || ':DR', now()
    FROM generate_series(1, ${ROWS}) g
    JOIN users u ON u.email = '${PERF_EMAIL}'
    JOIN accounts a ON a.user_id = u.id`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO transactions (id, user_id, account_id, category_id, type, amount, occurred_at, description, fingerprint, updated_at)
    SELECT gen_random_uuid(), u.id, a.id, NULL, 'EXPENSE', round((random() * 5000 + 1)::numeric, 2),
           now() - (random() * interval '730 days'), 'noise ' || g, md5('n' || g || u.email), now()
    FROM generate_series(1, ${Math.floor((ROWS * 2) / 20)}) g
    JOIN users u ON u.email LIKE 'noise%@spendsense.local'
    JOIN accounts a ON a.user_id = u.id`);
  await prisma.$executeRawUnsafe('ANALYZE transactions');

  const user = await prisma.user.findUniqueOrThrow({ where: { email: PERF_EMAIL } });
  const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id } });
  return { userId: user.id, accountId: account.id };
}

async function explain(title: string, sql: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
  const lines = rows.map((r) => r['QUERY PLAN']);
  const timing = lines.find((l) => l.startsWith('Execution Time')) ?? '';
  const scans = lines.filter((l) => /(Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan|Bitmap Index Scan)/.test(l)).map((l) => l.trim());
  console.log(`\n### ${title}\n${timing}`);
  scans.slice(0, 4).forEach((l) => console.log(`  ${l}`));
  if (process.env['VERBOSE']) console.log(lines.join('\n'));
}

async function main() {
  const { userId, accountId } = await ensureData();
  const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM transactions`;
  console.log(`transactions in table: ${n}`);

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString();
  const yearAgo = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)).toISOString();
  const U = `'${userId}'::uuid`;

  await explain('Ledger page 1 (user, newest first, LIMIT 51)',
    `SELECT * FROM transactions WHERE user_id = ${U} ORDER BY occurred_at DESC, id ASC LIMIT 51`);
  // Deep page: the cursor is split into (1) ties on the cursor timestamp, (2) strictly older rows.
  const cursorAt = `now() - interval '200 days'`;
  await explain('Ledger page N, naive OR cursor (the form we replaced)',
    `SELECT * FROM transactions WHERE user_id = ${U} AND (occurred_at < ${cursorAt} OR (occurred_at = ${cursorAt} AND id > gen_random_uuid())) ORDER BY occurred_at DESC, id ASC LIMIT 51`);
  await explain('Ledger page N, query 1 of 2 (ties on the cursor timestamp)',
    `SELECT * FROM transactions WHERE user_id = ${U} AND occurred_at = ${cursorAt} AND id > gen_random_uuid() ORDER BY id ASC LIMIT 51`);
  await explain('Ledger page N, query 2 of 2 (strictly older rows)',
    `SELECT * FROM transactions WHERE user_id = ${U} AND occurred_at < ${cursorAt} ORDER BY occurred_at DESC, id ASC LIMIT 51`);
  await explain('Ledger filtered by category',
    `SELECT * FROM transactions WHERE user_id = ${U} AND category_id = (SELECT id FROM categories WHERE is_system ORDER BY name LIMIT 1) ORDER BY occurred_at DESC, id ASC LIMIT 51`);
  await explain('Ledger search (ILIKE %term%)',
    `SELECT * FROM transactions WHERE user_id = ${U} AND description ILIKE '%merchant 17 %' ORDER BY occurred_at DESC, id ASC LIMIT 51`);
  await explain('Dashboard summary (one month, FILTER aggregates)',
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type='INCOME'),0), COALESCE(SUM(amount) FILTER (WHERE type='EXPENSE'),0), COALESCE(SUM(amount) FILTER (WHERE type='REFUND'),0), COUNT(*) FROM transactions WHERE user_id = ${U} AND occurred_at >= '${monthStart}' AND occurred_at < '${monthEnd}'`);
  await explain('Category breakdown (current + previous month)',
    `SELECT t.category_id, SUM(CASE WHEN t.type='REFUND' THEN -t.amount ELSE t.amount END) FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.user_id = ${U} AND t.type IN ('EXPENSE','REFUND') AND t.occurred_at >= '${prevStart}' AND t.occurred_at < '${monthEnd}' GROUP BY t.category_id, c.name ORDER BY 2 DESC`);
  await explain('Monthly trends (12 months, month bucketing in time zone)',
    `SELECT date_trunc('month', occurred_at AT TIME ZONE 'Asia/Kolkata') m, SUM(amount) FILTER (WHERE type='INCOME'), SUM(amount) FILTER (WHERE type='EXPENSE') FROM transactions WHERE user_id = ${U} AND occurred_at >= '${yearAgo}' AND occurred_at < '${monthEnd}' GROUP BY 1`);
  await explain('Recurring-expense input (bounded recent expenses)',
    `SELECT id, description, amount, occurred_at FROM transactions WHERE user_id = ${U} AND type = 'EXPENSE' AND occurred_at >= now() - interval '6 months' ORDER BY occurred_at DESC LIMIT 5000`);
  await explain('Import dedupe by bank reference (IN list)',
    `SELECT source_tx_id FROM transactions WHERE account_id = '${accountId}'::uuid AND source_tx_id IN ('REF1:DR','REF2:DR','REF3:DR','REF4:DR','REF5:DR')`);
  await explain('Import dedupe by fingerprint (IN list)',
    `SELECT fingerprint FROM transactions WHERE account_id = '${accountId}'::uuid AND fingerprint IN (md5('1'), md5('2'), md5('3'), md5('4'), md5('5'))`);
  await explain('Account balance (grouped by account)',
    `SELECT account_id, SUM(CASE WHEN type IN ('INCOME','REFUND') THEN amount WHEN type='EXPENSE' THEN -amount ELSE 0 END) FROM transactions WHERE user_id = ${U} GROUP BY account_id`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
