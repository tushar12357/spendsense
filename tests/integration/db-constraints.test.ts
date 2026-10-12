// The database itself must reject invalid data, independent of any API validation.
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/infrastructure/database/prisma';
import { resetDb } from '../helpers/db';

beforeEach(resetDb);

async function makeUser(email = `u${Math.random()}@x.com`) {
  return prisma.user.create({ data: { email, passwordHash: 'h', displayName: 'U' } });
}
async function makeAccount(userId: string, name = 'A') {
  return prisma.account.create({ data: { userId, name, type: 'SAVINGS' } });
}
const tx = (userId: string, accountId: string, over: Partial<Prisma.TransactionUncheckedCreateInput> = {}): Prisma.TransactionUncheckedCreateInput => ({
  userId, accountId, type: 'EXPENSE', amount: new Prisma.Decimal('10.00'), occurredAt: new Date(), description: 'd', ...over,
});

describe('ownership is enforced by foreign keys', () => {
  it("a transaction cannot reference another user's account", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const accountOfA = await makeAccount(a.id);
    await expect(prisma.transaction.create({ data: tx(b.id, accountOfA.id) })).rejects.toMatchObject({ code: 'P2003' });
  });

  it("an import batch cannot reference another user's account", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const accountOfA = await makeAccount(a.id);
    await expect(
      prisma.importBatch.create({ data: { userId: b.id, accountId: accountOfA.id, fileName: 'f.csv', fileHash: 'h', adapterKey: 'k' } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('accepts the legitimate owner', async () => {
    const a = await makeUser();
    const acc = await makeAccount(a.id);
    await expect(prisma.transaction.create({ data: tx(a.id, acc.id) })).resolves.toBeTruthy();
  });
});

describe('check constraints', () => {
  it('rejects zero / negative transaction amounts', async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    await expect(prisma.transaction.create({ data: tx(u.id, acc.id, { amount: new Prisma.Decimal('0') }) })).rejects.toThrow();
    await expect(prisma.transaction.create({ data: tx(u.id, acc.id, { amount: new Prisma.Decimal('-5') }) })).rejects.toThrow();
  });

  it('rejects malformed currency codes', async () => {
    const u = await makeUser();
    await expect(prisma.account.create({ data: { userId: u.id, name: 'x', type: 'CASH', currency: 'inr' } })).rejects.toThrow();
  });

  it('requires budgets to be keyed by the first day of a month', async () => {
    const u = await makeUser();
    const cat = await prisma.category.create({ data: { userId: u.id, name: 'c' } });
    const data = { userId: u.id, categoryId: cat.id, amount: new Prisma.Decimal('100') };
    await expect(prisma.budget.create({ data: { ...data, periodMonth: new Date('2026-10-15') } })).rejects.toThrow();
    await expect(prisma.budget.create({ data: { ...data, periodMonth: new Date('2026-10-01') } })).resolves.toBeTruthy();
  });

  it('stores money exactly (no float drift)', async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const created = await prisma.transaction.create({ data: tx(u.id, acc.id, { amount: new Prisma.Decimal('0.10') }) });
    const sum = await prisma.$queryRaw<Array<{ s: Prisma.Decimal }>>`SELECT (SUM(amount) + 0.20)::numeric(14,2) AS s FROM transactions WHERE id = ${created.id}::uuid`;
    expect(sum[0]!.s.toFixed(2)).toBe('0.30');
  });

  it('keeps import batch counters consistent', async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    await expect(
      prisma.importBatch.create({ data: { userId: u.id, accountId: acc.id, fileName: 'f', fileHash: 'h1', adapterKey: 'k', totalRows: 2, acceptedRows: 3 } }),
    ).rejects.toThrow();
  });
});

describe('uniqueness rules', () => {
  it('rejects the same bank reference twice on one account but allows it on another', async () => {
    const u = await makeUser();
    const [a1, a2] = [await makeAccount(u.id, 'A1'), await makeAccount(u.id, 'A2')];
    await prisma.transaction.create({ data: tx(u.id, a1.id, { sourceTxId: 'REF1:DR' }) });
    await expect(prisma.transaction.create({ data: tx(u.id, a1.id, { sourceTxId: 'REF1:DR' }) })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.transaction.create({ data: tx(u.id, a2.id, { sourceTxId: 'REF1:DR' }) })).resolves.toBeTruthy();
  });

  it('allows many transactions without a reference (NULLs are distinct)', async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    await prisma.transaction.create({ data: tx(u.id, acc.id) });
    await expect(prisma.transaction.create({ data: tx(u.id, acc.id) })).resolves.toBeTruthy();
  });

  it('keeps system category names unique (partial unique index)', async () => {
    await expect(prisma.category.create({ data: { name: 'Groceries', isSystem: true } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('keeps one file hash per user but lets different users import the same file', async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const [accA, accB] = [await makeAccount(a.id), await makeAccount(b.id)];
    const mk = (userId: string, accountId: string) => ({ userId, accountId, fileName: 'f', fileHash: 'same', adapterKey: 'k' });
    await prisma.importBatch.create({ data: mk(a.id, accA.id) });
    await expect(prisma.importBatch.create({ data: mk(a.id, accA.id) })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.importBatch.create({ data: mk(b.id, accB.id) })).resolves.toBeTruthy();
  });

  it('one budget per user, category and month', async () => {
    const u = await makeUser();
    const cat = await prisma.category.create({ data: { userId: u.id, name: 'c' } });
    const data = { userId: u.id, categoryId: cat.id, amount: new Prisma.Decimal('1'), periodMonth: new Date('2026-10-01') };
    await prisma.budget.create({ data });
    await expect(prisma.budget.create({ data })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a transaction cannot be its own transfer peer', async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const id = randomUUID();
    await expect(prisma.transaction.create({ data: tx(u.id, acc.id, { id, transferPeerId: id }) })).rejects.toThrow();
  });
});
