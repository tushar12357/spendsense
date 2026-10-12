// Supertest helpers: one app instance, quick user/account factories, CSV builders.
import request from 'supertest';
import { createApp } from '../../src/app';

export const app = createApp();
export const http = () => request(app);

let counter = 0;

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export async function registerUser(overrides: { timezone?: string; email?: string } = {}): Promise<TestUser> {
  counter += 1;
  const email = overrides.email ?? `user${counter}-${Date.now()}@example.com`;
  const res = await http()
    .post('/api/v1/auth/register')
    .send({ email, password: 'CorrectHorse9', displayName: `User ${counter}`, ...(overrides.timezone && { timezone: overrides.timezone }) });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id, email, token: res.body.token };
}

export const bearer = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

export async function createAccount(u: TestUser, over: Record<string, unknown> = {}): Promise<{ id: string }> {
  const res = await http()
    .post('/api/v1/accounts')
    .set(bearer(u))
    .send({ name: `Account ${++counter}`, type: 'SAVINGS', ...over });
  if (res.status !== 201) throw new Error(`createAccount failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export interface TxInput {
  accountId: string;
  type: 'INCOME' | 'EXPENSE' | 'REFUND' | 'TRANSFER';
  amount: string;
  description?: string;
  categoryId?: string;
  occurredAt?: string;
}

export async function addTx(u: TestUser, t: TxInput) {
  const res = await http()
    .post('/api/v1/transactions')
    .set(bearer(u))
    .send({ description: 'test transaction', ...t });
  if (res.status !== 201) throw new Error(`addTx failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string };
}

const HDFC_HEADER = 'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance';

/** Builds an HDFC-format CSV. Each row: [date, narration, ref, withdrawal, deposit]. */
export function hdfcCsv(rows: Array<[string, string, string, string, string]>): Buffer {
  const lines = rows.map(
    ([date, narration, ref, withdrawal, deposit]) =>
      `${date},${narration},${ref},${date},${withdrawal ? `"${withdrawal}"` : ''},${deposit ? `"${deposit}"` : ''},"0.00"`,
  );
  return Buffer.from([HDFC_HEADER, ...lines].join('\n'), 'utf8');
}

export async function uploadCsv(u: TestUser, accountId: string, csv: Buffer, extra: { adapterKey?: string; name?: string } = {}) {
  const req = http()
    .post('/api/v1/imports')
    .set(bearer(u))
    .field('accountId', accountId)
    .attach('file', csv, { filename: extra.name ?? 'statement.csv', contentType: 'text/csv' });
  if (extra.adapterKey) req.field('adapterKey', extra.adapterKey);
  return req;
}
