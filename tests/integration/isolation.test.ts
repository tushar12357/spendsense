// Cross-user access attempts: every resource family, read AND write.
import { beforeEach, describe, expect, it } from 'vitest';
import { addTx, bearer, createAccount, hdfcCsv, http, registerUser, uploadCsv, type TestUser } from '../helpers/api';
import { resetDb, systemCategoryId } from '../helpers/db';

let alice: TestUser;
let bob: TestUser;
let aliceAccount: string;
let aliceTx: string;
let aliceCategory: string;
let aliceBatch: string;
let aliceGoal: string;
let aliceRule: string;

beforeEach(async () => {
  await resetDb();
  alice = await registerUser();
  bob = await registerUser();
  aliceAccount = (await createAccount(alice)).id;
  const food = await systemCategoryId('Food & Dining');
  aliceTx = (await addTx(alice, { accountId: aliceAccount, type: 'EXPENSE', amount: '100.00', categoryId: food })).id;
  aliceCategory = (await http().post('/api/v1/categories').set(bearer(alice)).send({ name: 'Alice private' })).body.id;
  const imp = await uploadCsv(alice, aliceAccount, hdfcCsv([['02/10/2026', 'SWIGGY', 'R1', '100.00', '']]));
  aliceBatch = imp.body.batchId;
  aliceGoal = (await http().post('/api/v1/savings-goals').set(bearer(alice)).send({ name: 'Trip', targetAmount: '1000' })).body.id;
  aliceRule = (await http().post('/api/v1/merchant-rules').set(bearer(alice)).send({ pattern: 'swiggy', categoryId: food })).body.id;
  await http().put(`/api/v1/budgets/${food}`).set(bearer(alice)).send({ amount: '500' });
});

describe("Bob cannot see or touch Alice's data", () => {
  it('accounts', async () => {
    expect((await http().get(`/api/v1/accounts/${aliceAccount}`).set(bearer(bob))).status).toBe(404);
    expect((await http().patch(`/api/v1/accounts/${aliceAccount}`).set(bearer(bob)).send({ name: 'pwned' })).status).toBe(404);
    expect((await http().delete(`/api/v1/accounts/${aliceAccount}`).set(bearer(bob))).status).toBe(404);
    expect((await http().get('/api/v1/accounts').set(bearer(bob))).body).toEqual([]);
  });

  it('transactions (read, update, delete, list, search)', async () => {
    expect((await http().get(`/api/v1/transactions/${aliceTx}`).set(bearer(bob))).status).toBe(404);
    expect((await http().patch(`/api/v1/transactions/${aliceTx}`).set(bearer(bob)).send({ notes: 'x' })).status).toBe(404);
    expect((await http().delete(`/api/v1/transactions/${aliceTx}`).set(bearer(bob))).status).toBe(404);
    const list = await http().get('/api/v1/transactions').query({ q: 'test' }).set(bearer(bob));
    expect(list.body.data).toEqual([]);
    // Alice's data is untouched
    expect((await http().get(`/api/v1/transactions/${aliceTx}`).set(bearer(alice))).status).toBe(200);
  });

  it('cannot create transactions in, or import into, her account', async () => {
    const tx = await http().post('/api/v1/transactions').set(bearer(bob)).send({ accountId: aliceAccount, type: 'EXPENSE', amount: '1', description: 'x' });
    expect(tx.status).toBe(404);
    const imp = await uploadCsv(bob, aliceAccount, hdfcCsv([['03/10/2026', 'X', 'R9', '5.00', '']]));
    expect(imp.status).toBe(404);
  });

  it('import batches and their rows', async () => {
    expect((await http().get(`/api/v1/imports/${aliceBatch}`).set(bearer(bob))).status).toBe(404);
    expect((await http().get(`/api/v1/imports/${aliceBatch}/rows`).set(bearer(bob))).status).toBe(404);
    expect((await http().get('/api/v1/imports').set(bearer(bob))).body.data).toEqual([]);
  });

  it('categories: cannot use, edit or delete her private category', async () => {
    const cat = await http().patch(`/api/v1/categories/${aliceCategory}`).set(bearer(bob)).send({ name: 'x' });
    expect(cat.status).toBe(404);
    expect((await http().delete(`/api/v1/categories/${aliceCategory}`).set(bearer(bob))).status).toBe(404);
    const bobAccount = (await createAccount(bob)).id;
    const use = await http().post('/api/v1/transactions').set(bearer(bob)).send({ accountId: bobAccount, type: 'EXPENSE', amount: '1', description: 'x', categoryId: aliceCategory });
    expect(use.status).toBe(404);
    expect((await http().get('/api/v1/categories').set(bearer(bob))).body.map((c: { id: string }) => c.id)).not.toContain(aliceCategory);
  });

  it('cannot recategorize one of his own transactions into her private category', async () => {
    const bobAccount = (await createAccount(bob)).id;
    const tx = await addTx(bob, { accountId: bobAccount, type: 'EXPENSE', amount: '5.00' });
    const res = await http().patch(`/api/v1/transactions/${tx.id}`).set(bearer(bob)).send({ categoryId: aliceCategory });
    expect(res.status).toBe(404);
  });

  it('budgets: he sees none and cannot budget her category', async () => {
    const list = await http().get('/api/v1/budgets').set(bearer(bob));
    expect(list.body.budgets).toEqual([]);
    const res = await http().put(`/api/v1/budgets/${aliceCategory}`).set(bearer(bob)).send({ amount: '10' });
    expect(res.status).toBe(404);
    const food = await systemCategoryId('Food & Dining');
    expect((await http().delete(`/api/v1/budgets/${food}`).set(bearer(bob))).status).toBe(404);
  });

  it('savings goals', async () => {
    expect((await http().get('/api/v1/savings-goals').set(bearer(bob))).body).toEqual([]);
    expect((await http().patch(`/api/v1/savings-goals/${aliceGoal}`).set(bearer(bob)).send({ currentAmount: '999' })).status).toBe(404);
    expect((await http().delete(`/api/v1/savings-goals/${aliceGoal}`).set(bearer(bob))).status).toBe(404);
  });

  it('merchant rules', async () => {
    expect((await http().get('/api/v1/merchant-rules').set(bearer(bob))).body).toEqual([]);
    expect((await http().patch(`/api/v1/merchant-rules/${aliceRule}`).set(bearer(bob)).send({ pattern: 'zz' })).status).toBe(404);
    expect((await http().delete(`/api/v1/merchant-rules/${aliceRule}`).set(bearer(bob))).status).toBe(404);
    expect((await http().post(`/api/v1/merchant-rules/${aliceRule}/apply`).set(bearer(bob))).status).toBe(404);
  });

  it("analytics and export never include her money", async () => {
    expect((await http().get('/api/v1/dashboard/summary').set(bearer(bob))).body.totalExpenses).toBe('0.00');
    const exp = await http().get('/api/v1/users/me/export').set(bearer(bob));
    expect(exp.body.transactions).toEqual([]);
    expect(exp.body.accounts).toEqual([]);
  });

  it('malformed ids are a clean 400, not a database error', async () => {
    const res = await http().get('/api/v1/transactions/not-a-uuid').set(bearer(alice));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|P20\d\d|SELECT/i);
  });
});
