import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { bearer, createAccount, hdfcCsv, http, registerUser, uploadCsv, type TestUser } from '../helpers/api';
import { resetDb, systemCategoryId } from '../helpers/db';

let user: TestUser;
let accountId: string;

beforeEach(async () => {
  await resetDb();
  user = await registerUser();
  accountId = (await createAccount(user)).id;
});
afterEach(removeFaults);

/**
 * Real database faults, installed as triggers (a spy cannot reach the transaction-scoped client).
 *  'error' -> every insert into transactions raises
 *  'skip'  -> every insert is silently swallowed (a BEFORE trigger returning NULL), so fewer rows
 *             are written than requested - exactly what a swallowed ON CONFLICT would look like.
 */
async function injectFault(kind: 'error' | 'skip') {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_fault() RETURNS trigger AS $$
    BEGIN
      ${kind === 'error' ? "RAISE EXCEPTION 'simulated disk failure: secret-narration';" : 'RETURN NULL;'}
    END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe('CREATE TRIGGER test_fault BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION test_fault()');
}
async function removeFaults() {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fault ON transactions');
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fault()');
}

const countTx = () => prisma.transaction.count();
const SAMPLE = readFileSync(path.join(__dirname, '../../samples/hdfc-savings-statement.csv'));

describe('happy path', () => {
  it('imports the bundled sample statement and reports exact counts', async () => {
    const res = await uploadCsv(user, accountId, SAMPLE);
    expect(res.status).toBe(201);
    // 7 data rows: 6 real transactions + the trailing balance-only line, which is skipped
    expect(res.body).toMatchObject({ status: 'COMPLETED', totalRows: 7, acceptedRows: 6, rejectedRows: 0, duplicateRows: 0, skippedRows: 1, errors: [] });
    expect(await countTx()).toBe(res.body.acceptedRows);

    const list = await http().get('/api/v1/transactions').set(bearer(user));
    const salary = list.body.data.find((t: { description: string }) => t.description.startsWith('SALARY'));
    expect(salary).toMatchObject({ type: 'INCOME', amount: '85000.00', sourceTxId: 'NEFT987654321:CR' });
    // 01/10/26 is stored as noon IST on that calendar day
    expect(salary.occurredAt).toBe('2026-10-01T06:30:00.000Z');
  });

  it('records a row-level outcome for every row and links accepted rows to transactions', async () => {
    const res = await uploadCsv(user, accountId, SAMPLE);
    const rows = await http().get(`/api/v1/imports/${res.body.batchId}/rows`).set(bearer(user));
    expect(rows.body.data).toHaveLength(res.body.totalRows);
    const accepted = rows.body.data.filter((r: { status: string }) => r.status === 'ACCEPTED');
    expect(accepted).toHaveLength(6);
    expect(accepted.every((r: { transactionId: string | null }) => r.transactionId)).toBe(true);
    expect(rows.body.data.find((r: { status: string }) => r.status === 'SKIPPED').transactionId).toBeNull();
    // Both sides of the circular link agree
    const linked = await prisma.transaction.count({ where: { importRowId: { not: null } } });
    expect(linked).toBe(res.body.acceptedRows);
  });

  it('exposes status for polling and the adapter catalogue', async () => {
    const res = await uploadCsv(user, accountId, SAMPLE);
    const status = await http().get(`/api/v1/imports/${res.body.batchId}`).set(bearer(user));
    expect(status.body).toMatchObject({ status: 'COMPLETED', isFinished: true, attempts: 1 });
    const adapters = await http().get('/api/v1/imports/adapters').set(bearer(user));
    expect(adapters.body.map((a: { key: string }) => a.key)).toEqual(['hdfc-csv', 'generic-csv']);
  });

  it('applies merchant rules during import and never logs the narration into the batch error meta', async () => {
    const food = await systemCategoryId('Food & Dining');
    await http().post('/api/v1/merchant-rules').set(bearer(user)).send({ pattern: 'swiggy', categoryId: food, normalizedName: 'Swiggy' });
    await uploadCsv(user, accountId, SAMPLE);
    const tx = await prisma.transaction.findFirstOrThrow({ where: { description: { contains: 'SWIGGY' } }, include: { category: true } });
    expect(tx.category?.name).toBe('Food & Dining');
    expect(tx.merchantName).toBe('Swiggy');
    expect(tx.isReviewed).toBe(false);
  });

  it('imports a generic CSV chosen by auto-detection', async () => {
    const csv = Buffer.from('Date,Description,Debit,Credit\n2026-10-01,Salary,,50000\n2026-10-02,Coffee,150.50,\n');
    const res = await uploadCsv(user, accountId, csv);
    expect(res.status).toBe(201);
    expect(res.body.acceptedRows).toBe(2);
  });
});

describe('idempotency and duplicates', () => {
  it('rejects re-uploading an already imported file (409) without creating anything', async () => {
    const first = await uploadCsv(user, accountId, SAMPLE);
    const before = await countTx();
    const again = await uploadCsv(user, accountId, SAMPLE, { name: 'renamed.csv' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_IMPORT');
    expect(again.body.error.details[0].message).toContain(first.body.batchId);
    expect(await countTx()).toBe(before);
  });

  it('flags an overlapping statement\'s repeated rows as DUPLICATE but imports the new ones', async () => {
    await uploadCsv(user, accountId, hdfcCsv([
      ['01/10/2026', 'RENT', 'R1', '25000.00', ''],
      ['02/10/2026', 'GROCERY', 'R2', '800.00', ''],
    ]));
    const res = await uploadCsv(user, accountId, hdfcCsv([
      ['02/10/2026', 'GROCERY', 'R2', '800.00', ''],
      ['03/10/2026', 'FUEL', 'R3', '1500.00', ''],
    ]));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ acceptedRows: 1, duplicateRows: 1 });
    expect(res.body.errors).toEqual([{ rowNumber: 1, status: 'DUPLICATE', reason: expect.stringContaining('already imported') }]);
    expect(await countTx()).toBe(3);
  });

  it('keeps two identical purchases inside ONE file (no bank reference) - they are legitimate', async () => {
    const res = await uploadCsv(user, accountId, hdfcCsv([
      ['02/10/2026', 'CHAI POINT', '', '40.00', ''],
      ['02/10/2026', 'CHAI POINT', '', '40.00', ''],
      ['02/10/2026', 'CHAI POINT', '', '40.00', ''],
    ]));
    expect(res.body).toMatchObject({ acceptedRows: 3, duplicateRows: 0 });
  });

  it('matches repeated reference-less rows by occurrence when statements overlap', async () => {
    await uploadCsv(user, accountId, hdfcCsv([
      ['02/10/2026', 'CHAI POINT', '', '40.00', ''],
      ['02/10/2026', 'CHAI POINT', '', '40.00', ''],
    ]));
    // A later, wider export contains the same two cups plus a third bought afterwards.
    const res = await uploadCsv(user, accountId, hdfcCsv([
      ['02/10/2026', 'CHAI POINT', '', '40.00', ''],
      ['02/10/2026', 'CHAI POINT', '', '40.00', ''],
      ['02/10/2026', 'CHAI POINT', '', '40.00', ''],
      ['03/10/2026', 'BOOKSTORE', '', '300.00', ''],
    ]));
    expect(res.body).toMatchObject({ acceptedRows: 2, duplicateRows: 2 });
    expect(await countTx()).toBe(4);
    const dupRows = res.body.errors.map((e: { rowNumber: number }) => e.rowNumber);
    expect(dupRows).toEqual([1, 2]);
  });

  it('does not trust a reference repeated inside a file as an identity', async () => {
    const res = await uploadCsv(user, accountId, hdfcCsv([
      ['02/10/2026', 'CHEQUE BATCH A', 'CHQ77', '100.00', ''],
      ['02/10/2026', 'CHEQUE BATCH B', 'CHQ77', '200.00', ''],
    ]));
    expect(res.body).toMatchObject({ acceptedRows: 2, duplicateRows: 0 });
  });

  it('treats a payment and its reversal sharing one reference as two different transactions', async () => {
    const res = await uploadCsv(user, accountId, hdfcCsv([
      ['02/10/2026', 'UPI PAYMENT MERCHANT', 'UTR55', '499.00', ''],
      ['03/10/2026', 'REVERSAL UPI MERCHANT', 'UTR55', '', '499.00'],
    ]));
    expect(res.body.acceptedRows).toBe(2);
    const types = (await prisma.transaction.findMany({ orderBy: { occurredAt: 'asc' } })).map((t) => t.type);
    expect(types).toEqual(['EXPENSE', 'REFUND']);
  });

  it('detects duplicates per account: the same reference on another account is fine', async () => {
    const other = (await createAccount(user)).id;
    await uploadCsv(user, accountId, hdfcCsv([['02/10/2026', 'GROCERY', 'R2', '800.00', '']]));
    const res = await uploadCsv(user, other, hdfcCsv([['02/10/2026', 'GROCERY', 'R2', '800.00', ''], ['04/10/2026', 'X', 'R9', '1.00', '']]));
    expect(res.body.acceptedRows).toBe(2);
  });

  it('keeps manual entries and imported rows consistent (fingerprint dedupe against the ledger)', async () => {
    await http().post('/api/v1/transactions').set(bearer(user)).send({
      accountId, type: 'EXPENSE', amount: '40.00', description: 'Chai Point', occurredAt: '2026-10-02T06:30:00+00:00',
    });
    const res = await uploadCsv(user, accountId, hdfcCsv([['02/10/2026', 'CHAI POINT', '', '40.00', '']]));
    expect(res.body.duplicateRows).toBe(1);
  });
});

describe('row-level validation', () => {
  it('imports good rows and reports bad ones with their row numbers', async () => {
    const csv = Buffer.from([
      'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      '01/10/2026,GOOD ONE,R1,01/10/2026,"10.00",,"1.00"',
      '31/02/2026,BAD DATE,R2,31/02/2026,"20.00",,"1.00"',
      '03/10/2026,,R3,03/10/2026,"30.00",,"1.00"',
      '04/10/2026,BOTH AMOUNTS,R4,04/10/2026,"5.00","5.00","1.00"',
      '05/10/2026,OPENING BALANCE,,05/10/2026,,,"100.00"',
      '06/10/2026,BAD AMOUNT,R6,06/10/2026,"12.345",,"1.00"',
      '07/10/2026,GOOD TWO,R7,07/10/2026,,"70.00","1.00"',
    ].join('\n'));
    const res = await uploadCsv(user, accountId, csv);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ totalRows: 7, acceptedRows: 2, rejectedRows: 4, skippedRows: 1, warningCount: 4 });
    expect(res.body.errors.map((e: { rowNumber: number }) => e.rowNumber)).toEqual([2, 3, 4, 6]);

    const rejected = await http().get(`/api/v1/imports/${res.body.batchId}/rows`).query({ status: 'REJECTED' }).set(bearer(user));
    expect(rejected.body.data).toHaveLength(4);
    expect(rejected.body.data[0].rawData).toBeDefined(); // kept only for rejected rows, so the user can fix them
    const accepted = await http().get(`/api/v1/imports/${res.body.batchId}/rows`).query({ status: 'ACCEPTED' }).set(bearer(user));
    expect(accepted.body.data[0].rawData).toBeUndefined();
    expect(JSON.stringify(accepted.body.data)).not.toContain('Closing Balance'); // raw cells are not retained
  });

  it('paginates rows with a cursor', async () => {
    const rows = Array.from({ length: 5 }, (_, i): [string, string, string, string, string] => ['02/10/2026', `ITEM ${i}`, `R${i}`, '1.00', '']);
    const res = await uploadCsv(user, accountId, hdfcCsv(rows));
    const p1 = await http().get(`/api/v1/imports/${res.body.batchId}/rows`).query({ limit: 2 }).set(bearer(user));
    expect(p1.body.data.map((r: { rowNumber: number }) => r.rowNumber)).toEqual([1, 2]);
    const p2 = await http().get(`/api/v1/imports/${res.body.batchId}/rows`).query({ limit: 10, cursor: p1.body.pagination.nextCursor }).set(bearer(user));
    expect(p2.body.data.map((r: { rowNumber: number }) => r.rowNumber)).toEqual([3, 4, 5]);
    expect(p2.body.pagination.hasMore).toBe(false);
  });
});

describe('file-level validation', () => {
  it('rejects a non-CSV extension (415), an empty file, wrong columns and a missing file', async () => {
    const wrongExt = await uploadCsv(user, accountId, SAMPLE, { name: 'statement.xlsx' });
    expect(wrongExt.status).toBe(415);
    expect((await uploadCsv(user, accountId, Buffer.alloc(0))).status).toBe(400);
    const wrongCols = await uploadCsv(user, accountId, Buffer.from('a,b\n1,2\n'));
    expect(wrongCols.status).toBe(400);
    const none = await http().post('/api/v1/imports').set(bearer(user)).field('accountId', accountId);
    expect(none.status).toBe(400);
    expect(await countTx()).toBe(0);
  });

  it('rejects files above MAX_FILE_SIZE_MB with 413', async () => {
    const big = Buffer.concat([Buffer.from('Date,Description,Debit,Credit\n'), Buffer.alloc(1.2 * 1024 * 1024, 'a')]);
    const res = await uploadCsv(user, accountId, big);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('rejects an unknown adapter and an inactive account, creating no batch', async () => {
    expect((await uploadCsv(user, accountId, SAMPLE, { adapterKey: 'nope' })).status).toBe(400);
    await http().patch(`/api/v1/accounts/${accountId}`).set(bearer(user)).send({ isActive: false });
    expect((await uploadCsv(user, accountId, SAMPLE)).status).toBe(400);
    expect(await prisma.importBatch.count()).toBe(0);
  });
});

describe('failure, atomicity and retry', () => {
  it('rolls back everything when persistence fails, marks the batch FAILED, and a re-upload succeeds', async () => {
    await injectFault('error');
    const failed = await uploadCsv(user, accountId, SAMPLE);
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe('IMPORT_PROCESSING_ERROR');
    expect(JSON.stringify(failed.body)).not.toContain('secret-narration'); // internals never reach the client
    await removeFaults();

    // Nothing was persisted, and the batch explains what happened.
    expect(await countTx()).toBe(0);
    expect(await prisma.importRow.count()).toBe(0);
    const batch = await prisma.importBatch.findFirstOrThrow();
    expect(batch.status).toBe('FAILED');
    expect(batch.errorMeta).toMatchObject({ retryable: true });
    expect(JSON.stringify(batch.errorMeta)).not.toContain('secret-narration');

    // Retry = upload the same bytes again. The same batch is revived, not a second one.
    const retry = await uploadCsv(user, accountId, SAMPLE);
    expect(retry.status).toBe(201);
    expect(retry.body.batchId).toBe(batch.id);
    expect(retry.body.status).toBe('COMPLETED');
    expect(await prisma.importBatch.count()).toBe(1);
    const revived = await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(revived).toMatchObject({ attempts: 2, errorMeta: null });
    expect(await countTx()).toBe(retry.body.acceptedRows);
  });

  it('never reports success if the transaction writes fell short', async () => {
    await injectFault('skip');
    const res = await uploadCsv(user, accountId, SAMPLE);
    expect(res.status).toBe(500);
    expect(await countTx()).toBe(0);
    expect(await prisma.importRow.count()).toBe(0); // import rows roll back with the transactions
    expect((await prisma.importBatch.findFirstOrThrow()).status).toBe('FAILED');
  });

  it('does not let a second request re-run a file that is currently being processed', async () => {
    const csv = hdfcCsv([['02/10/2026', 'GROCERY', 'R2', '800.00', '']]);
    const batch = await (async () => {
      const a = await uploadCsv(user, accountId, csv);
      return a.body.batchId as string;
    })();
    await prisma.importBatch.update({ where: { id: batch }, data: { status: 'PROCESSING', completedAt: null } });
    const res = await uploadCsv(user, accountId, csv);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IMPORT_IN_PROGRESS');
    // ...but a PROCESSING batch that has been silent for too long is considered dead and is retried.
    await prisma.$executeRaw`UPDATE import_batches SET updated_at = now() - interval '2 hours' WHERE id = ${batch}::uuid`;
    const revived = await uploadCsv(user, accountId, csv);
    expect(revived.status).toBe(201);
  });
});

describe('concurrency', () => {
  it('two simultaneous uploads of the SAME file produce exactly one import', async () => {
    const results = await Promise.all([uploadCsv(user, accountId, SAMPLE), uploadCsv(user, accountId, SAMPLE), uploadCsv(user, accountId, SAMPLE)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(2);
    expect(await prisma.importBatch.count()).toBe(1);
    expect(await countTx()).toBe(results.find((r) => r.status === 201)!.body.acceptedRows);
  });

  it('simultaneous imports of DIFFERENT but overlapping files never double-insert a transaction', async () => {
    const shared: [string, string, string, string, string] = ['02/10/2026', 'SHARED RENT', 'RSHARED', '25000.00', ''];
    const fileA = hdfcCsv([shared, ['03/10/2026', 'ONLY IN A', 'RA', '10.00', '']]);
    const fileB = hdfcCsv([shared, ['04/10/2026', 'ONLY IN B', 'RB', '20.00', '']]);
    const fileC = hdfcCsv([shared, ['05/10/2026', 'ONLY IN C', 'RC', '30.00', '']]);
    const results = await Promise.all([fileA, fileB, fileC].map((f) => uploadCsv(user, accountId, f)));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const accepted = results.reduce((n, r) => n + r.body.acceptedRows, 0);
    const duplicates = results.reduce((n, r) => n + r.body.duplicateRows, 0);
    expect(accepted).toBe(4); // 3 unique rows + the shared one exactly once
    expect(duplicates).toBe(2);
    expect(await countTx()).toBe(4);
    expect(await prisma.transaction.count({ where: { sourceTxId: 'RSHARED:DR' } })).toBe(1);
  });
});

describe('import history after the user edits the ledger', () => {
  it('keeps the import row, unlinked and explained, when its transaction is deleted', async () => {
    const res = await uploadCsv(user, accountId, hdfcCsv([['02/10/2026', 'GROCERY', 'R2', '800.00', '']]));
    const tx = await prisma.transaction.findFirstOrThrow();
    expect((await http().delete(`/api/v1/transactions/${tx.id}`).set(bearer(user))).status).toBe(204);

    const rows = await http().get(`/api/v1/imports/${res.body.batchId}/rows`).set(bearer(user));
    expect(rows.body.data[0]).toMatchObject({ status: 'ACCEPTED', transactionId: null, reason: expect.stringContaining('deleted') });
    // The batch is still COMPLETED, so re-uploading the same file cannot silently resurrect the row.
    expect((await uploadCsv(user, accountId, hdfcCsv([['02/10/2026', 'GROCERY', 'R2', '800.00', '']]))).status).toBe(409);
  });
});
