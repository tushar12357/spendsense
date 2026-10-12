// Analytics against a small ledger with hand-computed expected values.
import { beforeEach, describe, expect, it } from 'vitest';
import { addTx, bearer, createAccount, http, registerUser, type TestUser } from '../helpers/api';
import { resetDb, systemCategoryId } from '../helpers/db';
import { Decimal } from '../../src/shared/utils/decimal';
import { getMonthlyTrends } from '../../src/modules/analytics/analytics.service';
import { getInsights } from '../../src/modules/analytics/insights.service';

/*
 * October 2026 (IST user)
 *   INCOME   85,000.00  Salary          (01 Oct)
 *   INCOME      156.75  Interest        (08 Oct)
 *   EXPENSE  25,000.00  Rent            (03 Oct)
 *   EXPENSE   1,250.50  Food & Dining   (02 Oct)
 *   EXPENSE   3,499.00  Groceries       (05 Oct)
 *   REFUND      499.00  Groceries       (06 Oct)
 *   TRANSFER 10,000.00                  (07 Oct)  <- must not count anywhere
 * September 2026
 *   INCOME   85,000.00  Salary
 *   EXPENSE  25,000.00  Rent
 *   EXPENSE   1,000.00  Food & Dining
 *
 *   Oct:  income 85,156.75 | expenses 29,749.50 | refunds 499.00 | net expenses 29,250.50
 *         net cash flow 55,906.25 | savings rate 65.65%
 */

let user: TestUser;
let accountId: string;
let cat: Record<string, string>;

const at = (date: string) => `${date}T06:30:00.000Z`; // 12:00 IST

async function seedLedger() {
  cat = {
    salary: await systemCategoryId('Salary'),
    rent: await systemCategoryId('Rent & Housing'),
    food: await systemCategoryId('Food & Dining'),
    groceries: await systemCategoryId('Groceries'),
    other: await systemCategoryId('Other Income'),
  };
  const add = (type: 'INCOME' | 'EXPENSE' | 'REFUND' | 'TRANSFER', amount: string, date: string, categoryId?: string) =>
    addTx(user, { accountId, type, amount, occurredAt: at(date), description: `${type} ${amount}`, ...(categoryId && { categoryId }) });
  await add('INCOME', '85000.00', '2026-10-01', cat['salary']);
  await add('INCOME', '156.75', '2026-10-08', cat['other']);
  await add('EXPENSE', '25000.00', '2026-10-03', cat['rent']);
  await add('EXPENSE', '1250.50', '2026-10-02', cat['food']);
  const groceryTx = await add('EXPENSE', '3499.00', '2026-10-05', cat['groceries']);
  await add('REFUND', '499.00', '2026-10-06', cat['groceries']);
  await add('TRANSFER', '10000.00', '2026-10-07');
  await add('INCOME', '85000.00', '2026-09-01', cat['salary']);
  await add('EXPENSE', '25000.00', '2026-09-03', cat['rent']);
  await add('EXPENSE', '1000.00', '2026-09-10', cat['food']);
  return { groceryTx };
}

beforeEach(async () => {
  await resetDb();
  user = await registerUser({ timezone: 'Asia/Kolkata' });
  accountId = (await createAccount(user, { openingBalance: '0' })).id;
});

const summary = (q = '?year=2026&month=10') => http().get(`/api/v1/dashboard/summary${q}`).set(bearer(user));

describe('dashboard summary', () => {
  it('computes exact monthly figures; transfers never count and refunds reduce expenses', async () => {
    await seedLedger();
    const res = await summary();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      currency: 'INR',
      period: { year: 2026, month: 10, label: '2026-10' },
      totalIncome: '85156.75',
      totalExpenses: '29749.50',
      totalRefunds: '499.00',
      netExpenses: '29250.50',
      netCashFlow: '55906.25',
      savingsRate: '65.65',
      transactionCount: 7,
      transferCount: 1,
    });
  });

  it('reconciles with the ledger: summing the listed transactions gives the dashboard figures', async () => {
    await seedLedger();
    const list = await http().get('/api/v1/transactions').query({ from: '2026-09-30T18:30:00Z', to: '2026-10-31T18:30:00Z', limit: 200 }).set(bearer(user));
    const sum = (type: string) =>
      list.body.data.filter((t: { type: string }) => t.type === type).reduce((s: Decimal, t: { amount: string }) => s.add(t.amount), new Decimal(0));
    const dash = (await summary()).body;
    expect(sum('INCOME').toFixed(2)).toBe(dash.totalIncome);
    expect(sum('EXPENSE').toFixed(2)).toBe(dash.totalExpenses);
    expect(sum('REFUND').toFixed(2)).toBe(dash.totalRefunds);
    expect(new Decimal(dash.totalIncome).sub(dash.netExpenses).toFixed(2)).toBe(dash.netCashFlow);
  });

  it('returns zeros and a null savings rate for an empty month (no division by zero)', async () => {
    const res = await summary('?year=2030&month=1');
    expect(res.body).toMatchObject({ totalIncome: '0.00', totalExpenses: '0.00', netCashFlow: '0.00', savingsRate: null, transactionCount: 0 });
  });

  it('reports a null savings rate (not 0%) when there is spending but no income', async () => {
    await addTx(user, { accountId, type: 'EXPENSE', amount: '100.00', occurredAt: at('2026-10-04') });
    const res = await summary();
    expect(res.body.savingsRate).toBeNull();
    expect(res.body.netCashFlow).toBe('-100.00');
  });

  it('reports a negative savings rate when spending exceeds income', async () => {
    await addTx(user, { accountId, type: 'INCOME', amount: '1000.00', occurredAt: at('2026-10-01') });
    await addTx(user, { accountId, type: 'EXPENSE', amount: '1500.00', occurredAt: at('2026-10-02') });
    expect((await summary()).body.savingsRate).toBe('-50.00');
  });

  it('validates the period parameters', async () => {
    expect((await summary('?year=2026')).status).toBe(400);
    expect((await summary('?year=2026&month=13')).status).toBe(400);
  });
});

describe('time zones and month boundaries', () => {
  // 2026-09-30T19:00Z is 1 October, 00:30 in India but still 30 September in UTC.
  const boundary = '2026-09-30T19:00:00.000Z';

  it('buckets a late-night transaction into the month the USER lives in', async () => {
    await addTx(user, { accountId, type: 'EXPENSE', amount: '70.00', occurredAt: boundary });
    expect((await summary('?year=2026&month=10')).body.totalExpenses).toBe('70.00');
    expect((await summary('?year=2026&month=9')).body.totalExpenses).toBe('0.00');
  });

  it('puts the same instant in September for a UTC user', async () => {
    const utcUser = await registerUser({ timezone: 'UTC' });
    const acc = (await createAccount(utcUser)).id;
    await addTx(utcUser, { accountId: acc, type: 'EXPENSE', amount: '70.00', occurredAt: boundary });
    const get = (m: number) => http().get(`/api/v1/dashboard/summary?year=2026&month=${m}`).set(bearer(utcUser));
    expect((await get(9)).body.totalExpenses).toBe('70.00');
    expect((await get(10)).body.totalExpenses).toBe('0.00');
  });

  it('treats the month end as exclusive: 1 Nov 00:00 IST belongs to November', async () => {
    await addTx(user, { accountId, type: 'EXPENSE', amount: '1.00', occurredAt: '2026-10-31T18:29:59.000Z' }); // 31 Oct 23:59:59 IST
    await addTx(user, { accountId, type: 'EXPENSE', amount: '2.00', occurredAt: '2026-10-31T18:30:00.000Z' }); // 1 Nov 00:00:00 IST
    expect((await summary('?year=2026&month=10')).body.totalExpenses).toBe('1.00');
    expect((await summary('?year=2026&month=11')).body.totalExpenses).toBe('2.00');
  });

  it('follows a changed reporting timezone immediately', async () => {
    await addTx(user, { accountId, type: 'EXPENSE', amount: '70.00', occurredAt: boundary });
    await http().patch('/api/v1/users/me').set(bearer(user)).send({ timezone: 'UTC' });
    expect((await summary('?year=2026&month=9')).body.totalExpenses).toBe('70.00');
  });
});

describe('category breakdown', () => {
  it('nets refunds into their category and compares with the previous month', async () => {
    await seedLedger();
    const res = await http().get('/api/v1/analytics/categories?year=2026&month=10').set(bearer(user));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe('29250.50');
    const by = Object.fromEntries(res.body.categories.map((c: { categoryName: string }) => [c.categoryName, c]));
    expect(by['Rent & Housing']).toMatchObject({ total: '25000.00', percentage: '85.47', previousTotal: '25000.00', changePct: '0.00', transactionCount: 1 });
    expect(by['Groceries']).toMatchObject({ total: '3000.00', percentage: '10.26', previousTotal: '0.00', changePct: null, transactionCount: 2 });
    expect(by['Food & Dining']).toMatchObject({ total: '1250.50', percentage: '4.28', previousTotal: '1000.00', changePct: '25.05' });
    expect(res.body.categories.map((c: { categoryName: string }) => c.categoryName)).toEqual(['Rent & Housing', 'Groceries', 'Food & Dining']);
  });

  it('groups uncategorized spending under "Uncategorized"', async () => {
    await addTx(user, { accountId, type: 'EXPENSE', amount: '40.00', occurredAt: at('2026-10-02') });
    const res = await http().get('/api/v1/analytics/categories?year=2026&month=10').set(bearer(user));
    expect(res.body.categories).toEqual([expect.objectContaining({ categoryId: null, categoryName: 'Uncategorized', total: '40.00' })]);
  });

  it('reflects a category correction immediately', async () => {
    const { groceryTx } = await seedLedger();
    await http().patch(`/api/v1/transactions/${groceryTx.id}`).set(bearer(user)).send({ categoryId: cat['food'] });
    const res = await http().get('/api/v1/analytics/categories?year=2026&month=10').set(bearer(user));
    const by = Object.fromEntries(res.body.categories.map((c: { categoryName: string }) => [c.categoryName, c]));
    expect(by['Food & Dining'].total).toBe('4749.50'); // 1250.50 + 3499.00
    expect(by['Groceries'].total).toBe('-499.00'); // the refund now sits alone in Groceries
  });
});

describe('monthly trends', () => {
  it('returns a gap-free series with month-over-month changes', async () => {
    await seedLedger();
    const now = new Date('2026-10-15T00:00:00Z');
    const { months } = await getMonthlyTrends(user.id, 'Asia/Kolkata', 3, now);
    expect(months).toEqual([
      { month: '2026-08', income: '0.00', netExpenses: '0.00', netCashFlow: '0.00', savingsRate: null, incomeChangePct: null, expenseChangePct: null },
      { month: '2026-09', income: '85000.00', netExpenses: '26000.00', netCashFlow: '59000.00', savingsRate: '69.41', incomeChangePct: null, expenseChangePct: null },
      { month: '2026-10', income: '85156.75', netExpenses: '29250.50', netCashFlow: '55906.25', savingsRate: '65.65', incomeChangePct: '0.18', expenseChangePct: '12.50' },
    ]);
  });

  it('is served by the API with a validated months parameter', async () => {
    const ok = await http().get('/api/v1/analytics/trends?months=6').set(bearer(user));
    expect(ok.status).toBe(200);
    expect(ok.body.months).toHaveLength(6);
    expect((await http().get('/api/v1/analytics/trends?months=0').set(bearer(user))).status).toBe(400);
  });
});

describe('budgets', () => {
  it('derives utilization from the ledger (refunds reduce spend) and flags status', async () => {
    await seedLedger();
    await http().put(`/api/v1/budgets/${cat['groceries']}`).set(bearer(user)).send({ amount: '4000', year: 2026, month: 10 });
    await http().put(`/api/v1/budgets/${cat['food']}`).set(bearer(user)).send({ amount: '1000.00', year: 2026, month: 10 });
    const res = await http().get('/api/v1/budgets?year=2026&month=10').set(bearer(user));
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.budgets.map((b: { category: { name: string } }) => [b.category.name, b]));
    expect(by['Groceries']).toMatchObject({ amount: '4000.00', spent: '3000.00', remaining: '1000.00', utilizationPct: '75.00', status: 'ok' });
    expect(by['Food & Dining']).toMatchObject({ amount: '1000.00', spent: '1250.50', remaining: '-250.50', utilizationPct: '125.05', status: 'exceeded' });
    expect(res.body.totals).toEqual({ budgeted: '5000.00', spent: '4250.50', remaining: '749.50' });
  });

  it('upserts (one budget per category per month), keeps months separate, and deletes', async () => {
    const put = (amount: string, month: number) => http().put(`/api/v1/budgets/${cat?.['food'] ?? ''}`).set(bearer(user)).send({ amount, year: 2026, month });
    cat = { food: await systemCategoryId('Food & Dining') };
    expect((await put('500', 10)).status).toBe(200);
    expect((await put('700', 10)).body.amount).toBe('700.00');
    expect((await put('900', 11)).status).toBe(200);
    expect((await http().get('/api/v1/budgets?year=2026&month=10').set(bearer(user))).body.budgets).toHaveLength(1);
    expect((await http().get('/api/v1/budgets?year=2026&month=10').set(bearer(user))).body.budgets[0].amount).toBe('700.00');
    expect((await http().delete(`/api/v1/budgets/${cat['food']}?year=2026&month=10`).set(bearer(user))).status).toBe(204);
    expect((await http().delete(`/api/v1/budgets/${cat['food']}?year=2026&month=10`).set(bearer(user))).status).toBe(404);
    expect((await http().get('/api/v1/budgets?year=2026&month=11').set(bearer(user))).body.budgets).toHaveLength(1);
  });

  it('rejects non-positive amounts', async () => {
    const food = await systemCategoryId('Food & Dining');
    expect((await http().put(`/api/v1/budgets/${food}`).set(bearer(user)).send({ amount: '0' })).status).toBe(400);
    expect((await http().put(`/api/v1/budgets/${food}`).set(bearer(user)).send({ amount: '-5' })).status).toBe(400);
  });
});

describe('savings goals', () => {
  it('computes progress and the monthly saving needed to reach the target date', async () => {
    const res = await http().post('/api/v1/savings-goals').set(bearer(user)).send({ name: 'Laptop', targetAmount: '90000', currentAmount: '30000.50', targetDate: '2099-12-31' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ targetAmount: '90000.00', currentAmount: '30000.50', remaining: '59999.50', progressPct: '33.33', status: 'ACTIVE', isOverdue: false });
    expect(res.body.requiredMonthlySaving).toEqual(expect.stringMatching(/^\d+\.\d{2}$/));
  });

  it('auto-marks a goal ACHIEVED when the target is reached', async () => {
    const goal = (await http().post('/api/v1/savings-goals').set(bearer(user)).send({ name: 'Trip', targetAmount: '1000' })).body;
    const res = await http().patch(`/api/v1/savings-goals/${goal.id}`).set(bearer(user)).send({ currentAmount: '1000' });
    expect(res.body).toMatchObject({ status: 'ACHIEVED', remaining: '0.00', progressPct: '100.00', requiredMonthlySaving: null });
  });

  it('flags an overdue goal', async () => {
    const res = await http().post('/api/v1/savings-goals').set(bearer(user)).send({ name: 'Old', targetAmount: '1000', targetDate: '2020-01-31' });
    expect(res.body.isOverdue).toBe(true);
    expect(res.body.requiredMonthlySaving).toBe('1000.00');
  });
});

describe('insights (forecast, recurring, safe-to-spend)', () => {
  async function seedInsights() {
    const acc = (await createAccount(user, { openingBalance: '5000.00', name: 'Insights account' })).id;
    const add = (type: 'INCOME' | 'EXPENSE', amount: string, date: string, description: string) =>
      addTx(user, { accountId: acc, type, amount, occurredAt: at(date), description });
    await add('INCOME', '50000.00', '2026-10-01', 'SALARY');
    await add('EXPENSE', '20000.00', '2026-10-03', 'RENT');
    for (const date of ['2026-07-20', '2026-08-20', '2026-09-20']) await add('EXPENSE', '649.00', date, 'NETFLIX.COM 4455');
    await http().post('/api/v1/savings-goals').set(bearer(user)).send({ name: 'Fund', targetAmount: '12000', targetDate: '2026-12-31' });
  }

  it('produces an exactly-computed, clearly-labelled estimate set', async () => {
    await seedInsights();
    const now = new Date('2026-10-12T06:00:00Z'); // 12 Oct, IST
    const r = await getInsights(user.id, 'Asia/Kolkata', now);

    expect(r.monthOverMonth).toMatchObject({
      current: { month: '2026-10', income: '50000.00', netExpenses: '20000.00' },
      previous: { month: '2026-09', income: '0.00', netExpenses: '649.00' },
      incomeChangePct: null,
      expenseChangePct: '2981.66',
    });

    // 20,000 spent in 12 of 31 days; blended with September's 649 (weight 12/31) -> 20000 + 649 x 19/31
    expect(r.forecast).toMatchObject({ isEstimate: true, spentToDate: '20000.00', projectedMonthEnd: '20397.77', method: 'blended-with-history', confidence: 'medium', daysElapsed: 12, daysRemaining: 19 });

    expect(r.recurringCandidates).toEqual([
      expect.objectContaining({ frequency: 'MONTHLY', typicalAmount: '649.00', occurrences: 3, lastSeen: '2026-09-20', nextExpected: '2026-10-20', status: 'UNCONFIRMED', confidence: 'medium' }),
    ]);

    // balance = 5000 + 50000 - 20000 - 3 x 649 = 33,053.00
    // safe     = 33,053 - 649 (Netflix due 20 Oct) - 4,000 (12,000 over Oct-Dec) = 28,404.00 over 20 days
    expect(r.safeToSpend).toMatchObject({
      isEstimate: true,
      amount: '28404.00',
      dailyAllowance: '1420.20',
      shortfall: false,
      breakdown: { availableBalance: '33053.00', upcomingObligations: '649.00', remainingSavingsCommitment: '4000.00' },
    });
    expect(r.safeToSpend.assumptions.length).toBeGreaterThan(0);
    expect(r.safeToSpend.upcomingObligations).toEqual([{ label: 'NETFLIX.COM 4455', amount: '649.00', dueDate: '2026-10-20' }]);
  });

  it('does not invent a balance when the user has no cash/bank account', async () => {
    const cardOnly = await registerUser();
    await createAccount(cardOnly, { type: 'CREDIT_CARD', name: 'Card' });
    const r = await getInsights(cardOnly.id, 'Asia/Kolkata', new Date('2026-10-12T06:00:00Z'));
    expect(r.safeToSpend.amount).toBeNull();
    expect(r.safeToSpend.dailyAllowance).toBeNull();
    expect(r.safeToSpend.assumptions.join(' ')).toMatch(/no cash\/bank account/i);
  });

  it('serves insights over HTTP', async () => {
    const res = await http().get('/api/v1/insights').set(bearer(user));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('forecast.isEstimate', true);
    expect(res.body).toHaveProperty('safeToSpend.isEstimate', true);
  });
});
