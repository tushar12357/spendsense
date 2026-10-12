// Background-import job semantics, exercised without Redis by calling the job handler directly
// (BullMQ only decides WHEN to call it; correctness lives in the handler + pipeline).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { prisma } from '../../src/infrastructure/database/prisma';
import { handleImportJob } from '../../src/modules/imports/import.worker';
import { registerImport } from '../../src/modules/imports/pipeline/register';
import { processBatch } from '../../src/modules/imports/pipeline/process-batch';
import { loadUpload, saveUpload, sweepOrphans } from '../../src/modules/imports/upload-store';
import { createAccount, hdfcCsv, registerUser, type TestUser } from '../helpers/api';
import { resetDb } from '../helpers/db';

let user: TestUser;
let accountId: string;

beforeEach(async () => {
  await resetDb();
  user = await registerUser();
  accountId = (await createAccount(user)).id;
});
afterEach(removeFault);

async function injectFault() {
  await prisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION test_fault() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated outage'; END $$ LANGUAGE plpgsql`,
  );
  await prisma.$executeRawUnsafe('CREATE TRIGGER test_fault BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION test_fault()');
}
async function removeFault() {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fault ON transactions');
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fault()');
}

const CSV = hdfcCsv([
  ['02/10/2026', 'GROCERY', 'R2', '800.00', ''],
  ['03/10/2026', 'FUEL', 'R3', '1500.00', ''],
]);

/** What the API does in async mode: register the batch, park the file for the worker. */
async function queued(csv: Buffer = CSV) {
  const { batch } = await registerImport({ userId: user.id, accountId, fileName: 'a.csv', fileBuffer: csv });
  await saveUpload(batch.id, csv);
  return batch.id;
}
const job = (batchId: string, attemptsMade = 0, attempts = 3) =>
  ({ id: batchId, data: { batchId, correlationId: 'req-1' }, attemptsMade, opts: { attempts } });
const fileExists = (id: string) => existsSync(path.resolve('./tmp/test-uploads', `${id}.csv`));

describe('import job handler', () => {
  it('processes a queued batch, completes it and removes the temp file', async () => {
    const id = await queued();
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
    await handleImportJob(job(id));
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id } });
    expect(batch).toMatchObject({ status: 'COMPLETED', acceptedRows: 2, attempts: 1 });
    expect(await prisma.transaction.count()).toBe(2);
    expect(fileExists(id)).toBe(false);
  });

  it('is safe under re-delivery: a second run of a finished job changes nothing', async () => {
    const id = await queued();
    await handleImportJob(job(id));
    await expect(handleImportJob(job(id, 1))).resolves.toBeUndefined(); // file is gone, batch already COMPLETED
    expect(await prisma.transaction.count()).toBe(2);
    // ...and re-running the pipeline itself with the file is a no-op too.
    const again = await processBatch(id, CSV);
    expect(again).toMatchObject({ status: 'COMPLETED', acceptedRows: 2 });
    expect(await prisma.transaction.count()).toBe(2);
  });

  it('survives two workers receiving the same job at once', async () => {
    const id = await queued();
    await Promise.all([processBatch(id, CSV), processBatch(id, CSV)]);
    expect(await prisma.transaction.count()).toBe(2);
    expect(await prisma.importRow.count({ where: { batchId: id } })).toBe(2);
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id } })).status).toBe('COMPLETED');
  });

  it('retries a transient failure: PARTIAL between attempts (file kept), COMPLETED when the outage ends', async () => {
    const id = await queued();
    await injectFault();
    await expect(handleImportJob(job(id, 0))).rejects.toThrow();
    let batch = await prisma.importBatch.findUniqueOrThrow({ where: { id } });
    expect(batch.status).toBe('PARTIAL');
    expect(batch.errorMeta).toMatchObject({ retryable: true });
    expect(await prisma.transaction.count()).toBe(0);
    expect(fileExists(id)).toBe(true); // the retry needs it

    await removeFault();
    await handleImportJob(job(id, 1));
    batch = await prisma.importBatch.findUniqueOrThrow({ where: { id } });
    expect(batch).toMatchObject({ status: 'COMPLETED', attempts: 2, errorMeta: null });
    expect(await prisma.transaction.count()).toBe(2);
    expect(fileExists(id)).toBe(false);
  });

  it('gives up cleanly on the last attempt: FAILED, nothing persisted, temp file deleted', async () => {
    const id = await queued();
    await injectFault();
    await expect(handleImportJob(job(id, 2, 3))).rejects.toThrow();
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id } });
    expect(batch.status).toBe('FAILED');
    expect(batch.completedAt).not.toBeNull();
    expect(await prisma.transaction.count()).toBe(0);
    expect(fileExists(id)).toBe(false);
  });

  it('treats a permanent error as unrecoverable (no retries) and marks the batch FAILED', async () => {
    const id = await queued();
    await saveUpload(id, Buffer.from('this,is,not,a,statement\n1,2,3,4,5\n')); // content changed under us
    await expect(handleImportJob(job(id, 0))).rejects.toBeInstanceOf(UnrecoverableError);
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id } });
    expect(batch).toMatchObject({ status: 'FAILED' });
    expect(batch.errorMeta).toMatchObject({ retryable: false });
    expect(fileExists(id)).toBe(false);
  });

  it('fails unrecoverably when the uploaded file has disappeared', async () => {
    const id = await queued();
    await import('node:fs/promises').then((fs) => fs.rm(path.resolve('./tmp/test-uploads', `${id}.csv`)));
    await expect(handleImportJob(job(id))).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id } })).status).toBe('FAILED');
  });

  it('lets the user re-upload a FAILED file and get a normal import', async () => {
    const id = await queued();
    await injectFault();
    await expect(handleImportJob(job(id, 2, 3))).rejects.toThrow();
    await removeFault();
    const again = await registerImport({ userId: user.id, accountId, fileName: 'a.csv', fileBuffer: CSV });
    expect(again.revived).toBe(true);
    expect(again.batch.id).toBe(id);
    expect(again.batch.status).toBe('PENDING');
  });
});

describe('upload store', () => {
  it('writes private files named only by batch id, refuses path traversal, and sweeps old files', async () => {
    const id = '3f0c1f6e-8d3a-4c58-9e67-0f6f5a9c1b2d';
    await saveUpload(id, Buffer.from('x'));
    expect((await loadUpload(id))!.toString()).toBe('x');
    expect(await loadUpload('4f0c1f6e-8d3a-4c58-9e67-0f6f5a9c1b2d')).toBeNull();
    await expect(saveUpload('../../etc/passwd', Buffer.from('x'))).rejects.toThrow(/Invalid batch id/);
    expect(await sweepOrphans(60_000)).toBe(0); // too fresh
    expect(await sweepOrphans(-1)).toBeGreaterThanOrEqual(1);
    expect(await loadUpload(id)).toBeNull();
  });
});
