// Accounts, categories, merchant rules and the user's own data (profile, export, deletion).
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { addTx, bearer, createAccount, hdfcCsv, http, registerUser, uploadCsv, type TestUser } from '../helpers/api';
import { resetDb, systemCategoryId } from '../helpers/db';

let user: TestUser;

beforeEach(async () => {
  await resetDb();
  user = await registerUser();
});

describe('accounts', () => {
  it('derives the balance from opening balance + ledger, and flags transfers as an estimate', async () => {
    const acc = (await createAccount(user, { openingBalance: '1000.00' })).id;
    await addTx(user, { accountId: acc, type: 'INCOME', amount: '500.00' });
    await addTx(user, { accountId: acc, type: 'EXPENSE', amount: '200.25' });
    await addTx(user, { accountId: acc, type: 'REFUND', amount: '50.00' });
    let res = await http().get(`/api/v1/accounts/${acc}`).set(bearer(user));
    expect(res.body).toMatchObject({ openingBalance: '1000.00', currentBalance: '1349.75', balanceIsEstimate: false });

    await addTx(user, { accountId: acc, type: 'TRANSFER', amount: '300.00' });
    res = await http().get(`/api/v1/accounts/${acc}`).set(bearer(user));
    expect(res.body).toMatchObject({ currentBalance: '1349.75', balanceIsEstimate: true });
    const list = await http().get('/api/v1/accounts').set(bearer(user));
    expect(list.body[0].currentBalance).toBe('1349.75');
  });

  it('enforces unique names per user and validates input', async () => {
    await createAccount(user, { name: 'Salary a/c' });
    const dup = await http().post('/api/v1/accounts').set(bearer(user)).send({ name: 'Salary a/c', type: 'SAVINGS' });
    expect(dup.status).toBe(409);
    expect((await http().post('/api/v1/accounts').set(bearer(user)).send({ name: 'x', type: 'BITCOIN' })).status).toBe(400);
    expect((await http().post('/api/v1/accounts').set(bearer(user)).send({ name: 'x', type: 'SAVINGS', openingBalance: '-5' })).status).toBe(400);
    expect((await http().post('/api/v1/accounts').set(bearer(user)).send({ name: 'x', type: 'SAVINGS', currency: 'USD' })).status).toBe(400);
  });

  it('refuses to delete an account that has history but allows deleting an empty one', async () => {
    const used = (await createAccount(user)).id;
    await addTx(user, { accountId: used, type: 'EXPENSE', amount: '1.00' });
    const del = await http().delete(`/api/v1/accounts/${used}`).set(bearer(user));
    expect(del.status).toBe(409);
    expect(del.body.error.message).toMatch(/deactivate/i);
    const empty = (await createAccount(user)).id;
    expect((await http().delete(`/api/v1/accounts/${empty}`).set(bearer(user))).status).toBe(204);
  });
});

describe('categories', () => {
  it('lists system categories plus the user\'s own, and keeps system ones immutable', async () => {
    const mine = await http().post('/api/v1/categories').set(bearer(user)).send({ name: 'Pets', color: '#112233' });
    expect(mine.status).toBe(201);
    const list = await http().get('/api/v1/categories').set(bearer(user));
    const names = list.body.map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Groceries', 'Pets']));
    const groceries = await systemCategoryId('Groceries');
    expect((await http().patch(`/api/v1/categories/${groceries}`).set(bearer(user)).send({ name: 'Hacked' })).status).toBe(404);
    expect((await http().delete(`/api/v1/categories/${groceries}`).set(bearer(user))).status).toBe(404);
  });

  it('validates parents: visible, top-level only, and not self', async () => {
    const parent = (await http().post('/api/v1/categories').set(bearer(user)).send({ name: 'Parent' })).body.id;
    const child = await http().post('/api/v1/categories').set(bearer(user)).send({ name: 'Child', parentId: parent });
    expect(child.status).toBe(201);
    expect((await http().post('/api/v1/categories').set(bearer(user)).send({ name: 'Grandchild', parentId: child.body.id })).status).toBe(400);
    expect((await http().patch(`/api/v1/categories/${parent}`).set(bearer(user)).send({ parentId: parent })).status).toBe(400);
    expect((await http().patch(`/api/v1/categories/${parent}`).set(bearer(user)).send({ parentId: child.body.id })).status).toBe(400);
  });

  it('deleting a category keeps the ledger: transactions become uncategorized, budget and rules go', async () => {
    const acc = (await createAccount(user)).id;
    const cat = (await http().post('/api/v1/categories').set(bearer(user)).send({ name: 'Hobby' })).body.id;
    const tx = await addTx(user, { accountId: acc, type: 'EXPENSE', amount: '10.00', categoryId: cat });
    await http().put(`/api/v1/budgets/${cat}`).set(bearer(user)).send({ amount: '100' });
    await http().post('/api/v1/merchant-rules').set(bearer(user)).send({ pattern: 'hobby', categoryId: cat });

    expect((await http().delete(`/api/v1/categories/${cat}`).set(bearer(user))).status).toBe(204);
    const after = await http().get(`/api/v1/transactions/${tx.id}`).set(bearer(user));
    expect(after.status).toBe(200);
    expect(after.body.category).toBeNull();
    expect(await prisma.budget.count()).toBe(0);
    expect(await prisma.merchantRule.count()).toBe(0);
  });
});

describe('merchant rules', () => {
  it('applies a rule to unreviewed transactions only - user corrections always win', async () => {
    const acc = (await createAccount(user)).id;
    const food = await systemCategoryId('Food & Dining');
    const shopping = await systemCategoryId('Shopping');
    await uploadCsv(user, acc, hdfcCsv([
      ['02/10/2026', 'UPI-SWIGGY ORDER 1', 'R1', '100.00', ''],
      ['03/10/2026', 'UPI-SWIGGY ORDER 2', 'R2', '200.00', ''],
      ['04/10/2026', 'UPI-AMAZON', 'R3', '300.00', ''],
    ]));
    const swiggy2 = await prisma.transaction.findFirstOrThrow({ where: { description: { contains: 'ORDER 2' } } });
    await http().patch(`/api/v1/transactions/${swiggy2.id}`).set(bearer(user)).send({ categoryId: shopping }); // deliberate correction

    const rule = (await http().post('/api/v1/merchant-rules').set(bearer(user)).send({ pattern: 'swiggy', categoryId: food, normalizedName: 'Swiggy' })).body;
    const applied = await http().post(`/api/v1/merchant-rules/${rule.id}/apply`).set(bearer(user));
    expect(applied.body).toEqual({ updated: 1 });

    const txs = await prisma.transaction.findMany({ include: { category: true }, orderBy: { occurredAt: 'asc' } });
    expect(txs.map((t) => t.category?.name ?? null)).toEqual(['Food & Dining', 'Shopping', null]);
    expect(txs[0]!.merchantName).toBe('Swiggy');
  });

  it('matches wildcard characters literally', async () => {
    const acc = (await createAccount(user)).id;
    const food = await systemCategoryId('Food & Dining');
    await addTx(user, { accountId: acc, type: 'EXPENSE', amount: '5.00', description: 'anything at all' });
    await prisma.transaction.updateMany({ data: { isReviewed: false } });
    const rule = (await http().post('/api/v1/merchant-rules').set(bearer(user)).send({ pattern: '%%', categoryId: food })).body;
    expect((await http().post(`/api/v1/merchant-rules/${rule.id}/apply`).set(bearer(user))).body).toEqual({ updated: 0 });
  });

  it('validates rules', async () => {
    const food = await systemCategoryId('Food & Dining');
    expect((await http().post('/api/v1/merchant-rules').set(bearer(user)).send({ pattern: 'a', categoryId: food })).status).toBe(400);
    expect((await http().post('/api/v1/merchant-rules').set(bearer(user)).send({ pattern: 'ok', categoryId: 'nope' })).status).toBe(400);
  });
});

describe('profile, export and account deletion', () => {
  it('updates the profile and rejects an invalid timezone', async () => {
    const ok = await http().patch('/api/v1/users/me').set(bearer(user)).send({ displayName: 'Renamed', timezone: 'America/New_York' });
    expect(ok.body).toMatchObject({ displayName: 'Renamed', timezone: 'America/New_York' });
    expect((await http().patch('/api/v1/users/me').set(bearer(user)).send({ timezone: 'Atlantis/Lost' })).status).toBe(400);
  });

  it('exports everything the user owns, with exact money strings and no password hash', async () => {
    const acc = (await createAccount(user, { openingBalance: '10.50' })).id;
    await uploadCsv(user, acc, hdfcCsv([['02/10/2026', 'GROCERY', 'R2', '800.00', ''], ['03/10/2026', 'BAD', 'R3', 'zzz', '']]));
    await http().post('/api/v1/savings-goals').set(bearer(user)).send({ name: 'Goal', targetAmount: '99.99' });
    const res = await http().get('/api/v1/users/me/export').set(bearer(user));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body.accounts[0].openingBalance).toBe('10.50');
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].amount).toBe('800.00');
    expect(res.body.importBatches[0].rows).toHaveLength(2);
    expect(res.body.savingsGoals[0].targetAmount).toBe('99.99');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });

  it('deletes the account and all of its data - but only with the correct password, and never touches other users', async () => {
    const other = await registerUser();
    const otherAcc = (await createAccount(other)).id;
    await addTx(other, { accountId: otherAcc, type: 'EXPENSE', amount: '7.00' });

    const acc = (await createAccount(user)).id;
    const cat = (await http().post('/api/v1/categories').set(bearer(user)).send({ name: 'Mine' })).body.id;
    await uploadCsv(user, acc, hdfcCsv([['02/10/2026', 'GROCERY', 'R2', '800.00', '']]));
    await http().put(`/api/v1/budgets/${cat}`).set(bearer(user)).send({ amount: '10' });
    await http().post('/api/v1/merchant-rules').set(bearer(user)).send({ pattern: 'groc', categoryId: cat });
    await http().post('/api/v1/savings-goals').set(bearer(user)).send({ name: 'G', targetAmount: '10' });

    expect((await http().delete('/api/v1/users/me').set(bearer(user)).send({ password: 'wrong-password-1' })).status).toBe(401);
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(1);

    expect((await http().delete('/api/v1/users/me').set(bearer(user)).send({ password: 'CorrectHorse9' })).status).toBe(204);
    for (const table of ['transaction', 'account', 'importBatch', 'budget', 'merchantRule', 'savingsGoal', 'category'] as const) {
      expect(await (prisma[table] as unknown as { count: (a: unknown) => Promise<number> }).count({ where: { userId: user.id } }), table).toBe(0);
    }
    expect(await prisma.importRow.count({ where: { batch: { userId: user.id } } })).toBe(0);
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
    // The other user is untouched, and the shared system categories survive.
    expect(await prisma.transaction.count({ where: { userId: other.id } })).toBe(1);
    expect(await prisma.category.count({ where: { isSystem: true } })).toBeGreaterThan(10);
    expect((await http().post('/api/v1/auth/login').send({ email: user.email, password: 'CorrectHorse9' })).status).toBe(401);
  });
});
