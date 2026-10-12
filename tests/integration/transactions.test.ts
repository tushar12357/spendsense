import { beforeEach, describe, expect, it } from 'vitest';
import { addTx, bearer, createAccount, http, registerUser, type TestUser } from '../helpers/api';
import { resetDb, systemCategoryId } from '../helpers/db';

let user: TestUser;
let accountId: string;

beforeEach(async () => {
  await resetDb();
  user = await registerUser();
  accountId = (await createAccount(user)).id;
});

const get = (q: Record<string, string | number> = {}) => http().get('/api/v1/transactions').query(q).set(bearer(user));

describe('create', () => {
  it('stores exact money and serializes it as a 2dp string', async () => {
    const groceries = await systemCategoryId('Groceries');
    const res = await http().post('/api/v1/transactions').set(bearer(user)).send({
      accountId, type: 'EXPENSE', amount: '1234.5', description: ' Big Basket ', categoryId: groceries, occurredAt: '2026-10-02T10:00:00+05:30',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount: '1234.50', type: 'EXPENSE', description: 'Big Basket', currency: 'INR', isReviewed: true });
    expect(res.body.occurredAt).toBe('2026-10-02T04:30:00.000Z');
    expect(res.body.category.name).toBe('Groceries');
  });

  it.each([
    ['zero amount', { amount: '0' }],
    ['negative amount', { amount: '-1' }],
    ['3 decimal places', { amount: '1.234' }],
    ['numeric (float) amount', { amount: 12.5 }],
    ['unknown type', { type: 'GIFT' }],
    ['empty description', { description: '  ' }],
  ])('rejects %s', async (_n, bad) => {
    const res = await http().post('/api/v1/transactions').set(bearer(user)).send({ accountId, type: 'EXPENSE', amount: '10', description: 'x', ...bad });
    expect(res.status).toBe(400);
  });

  it('rejects entries on an inactive account', async () => {
    await http().patch(`/api/v1/accounts/${accountId}`).set(bearer(user)).send({ isActive: false });
    const res = await http().post('/api/v1/transactions').set(bearer(user)).send({ accountId, type: 'EXPENSE', amount: '10', description: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('listing, filters and pagination', () => {
  it('orders by date desc with id as the tie-breaker and pages without gaps or repeats', async () => {
    const same = '2026-10-05T06:30:00.000Z';
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push((await addTx(user, { accountId, type: 'EXPENSE', amount: `${i + 1}.00`, occurredAt: i < 4 ? same : `2026-09-0${i}T06:30:00.000Z`, description: `row ${i}` })).id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await get({ limit: 3, ...(cursor && { cursor }) });
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((t: { id: string }) => t.id));
      if (!res.body.pagination.hasMore) break;
      cursor = res.body.pagination.nextCursor;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(new Set(seen)).toEqual(new Set(ids));
    // The four tied rows come first, ordered by id ascending
    const tied = seen.slice(0, 4);
    expect(tied).toEqual([...tied].sort());
  });

  it('filters by date range ([from, to) half-open), type, account and category', async () => {
    const food = await systemCategoryId('Food & Dining');
    const other = (await createAccount(user)).id;
    await addTx(user, { accountId, type: 'EXPENSE', amount: '10.00', occurredAt: '2026-10-01T00:00:00.000Z', categoryId: food });
    await addTx(user, { accountId, type: 'INCOME', amount: '20.00', occurredAt: '2026-10-02T00:00:00.000Z' });
    await addTx(user, { accountId: other, type: 'EXPENSE', amount: '30.00', occurredAt: '2026-10-03T00:00:00.000Z' });

    expect((await get({ from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' })).body.data.map((t: { amount: string }) => t.amount)).toEqual(['10.00']);
    expect((await get({ type: 'INCOME' })).body.data).toHaveLength(1);
    expect((await get({ accountId: other })).body.data).toHaveLength(1);
    expect((await get({ categoryId: food })).body.data).toHaveLength(1);
    expect((await get({ uncategorized: 'true' })).body.data).toHaveLength(2);
  });

  it('searches description and merchant name case-insensitively', async () => {
    await addTx(user, { accountId, type: 'EXPENSE', amount: '10.00', description: 'UPI-SWIGGY BANGALORE' });
    const t = await addTx(user, { accountId, type: 'EXPENSE', amount: '11.00', description: 'ref 99' });
    await http().patch(`/api/v1/transactions/${t.id}`).set(bearer(user)).send({ merchantName: 'Zomato' });
    expect((await get({ q: 'swiggy' })).body.data).toHaveLength(1);
    expect((await get({ q: 'ZOMATO' })).body.data).toHaveLength(1);
    expect((await get({ q: 'nothing' })).body.data).toHaveLength(0);
  });

  it('combines search with a cursor (regression: the cursor must not discard the search filter)', async () => {
    for (let i = 0; i < 5; i++) await addTx(user, { accountId, type: 'EXPENSE', amount: '5.00', description: 'COFFEE SHOP', occurredAt: `2026-10-0${i + 1}T00:00:00.000Z` });
    for (let i = 0; i < 5; i++) await addTx(user, { accountId, type: 'EXPENSE', amount: '9.00', description: 'TAXI', occurredAt: `2026-09-0${i + 1}T00:00:00.000Z` });
    const first = await get({ q: 'coffee', limit: 2 });
    expect(first.body.data).toHaveLength(2);
    const second = await get({ q: 'coffee', limit: 10, cursor: first.body.pagination.nextCursor });
    expect(second.body.data).toHaveLength(3);
    expect(second.body.data.every((t: { description: string }) => t.description === 'COFFEE SHOP')).toBe(true);
  });

  it('treats LIKE wildcards in the search term literally', async () => {
    await addTx(user, { accountId, type: 'EXPENSE', amount: '1.00', description: 'plain text' });
    expect((await get({ q: '%' })).body.data).toHaveLength(0);
    expect((await get({ q: '_____' })).body.data).toHaveLength(0);
  });

  it('rejects tampered cursors and bad ranges with 400', async () => {
    expect((await get({ cursor: 'garbage' })).status).toBe(400);
    expect((await get({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' })).status).toBe(400);
    expect((await get({ limit: 5000 })).status).toBe(400);
  });
});

describe('corrections and deletion', () => {
  it('lets the user correct category, merchant and notes, marking the row reviewed', async () => {
    const t = await addTx(user, { accountId, type: 'EXPENSE', amount: '10.00' });
    const travel = await systemCategoryId('Travel');
    const res = await http().patch(`/api/v1/transactions/${t.id}`).set(bearer(user)).send({ categoryId: travel, merchantName: 'IRCTC', notes: 'train' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ merchantName: 'IRCTC', notes: 'train', isReviewed: true });
    expect(res.body.category.name).toBe('Travel');
    const cleared = await http().patch(`/api/v1/transactions/${t.id}`).set(bearer(user)).send({ categoryId: null, notes: null });
    expect(cleared.body.category).toBeNull();
    expect(cleared.body.notes).toBeNull();
  });

  it('reclassifies the type (e.g. EXPENSE -> TRANSFER) and rejects empty / unknown fields', async () => {
    const t = await addTx(user, { accountId, type: 'EXPENSE', amount: '10.00' });
    expect((await http().patch(`/api/v1/transactions/${t.id}`).set(bearer(user)).send({ type: 'TRANSFER' })).body.type).toBe('TRANSFER');
    expect((await http().patch(`/api/v1/transactions/${t.id}`).set(bearer(user)).send({})).status).toBe(400);
    expect((await http().patch(`/api/v1/transactions/${t.id}`).set(bearer(user)).send({ type: 'BOGUS' })).status).toBe(400);
  });

  it('does not allow amount or date edits through PATCH (the ledger is the source of truth)', async () => {
    const t = await addTx(user, { accountId, type: 'EXPENSE', amount: '10.00' });
    const res = await http().patch(`/api/v1/transactions/${t.id}`).set(bearer(user)).send({ amount: '999.00', notes: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe('10.00');
  });

  it('deletes a transaction (204) and then 404s', async () => {
    const t = await addTx(user, { accountId, type: 'EXPENSE', amount: '10.00' });
    expect((await http().delete(`/api/v1/transactions/${t.id}`).set(bearer(user))).status).toBe(204);
    expect((await http().get(`/api/v1/transactions/${t.id}`).set(bearer(user))).status).toBe(404);
  });
});
