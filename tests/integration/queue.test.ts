// End-to-end background imports through a REAL Redis + BullMQ worker.
// Opt-in: needs Redis, so it only runs when REDIS_TEST=1  (e.g. `docker compose up -d redis`, then
// `REDIS_TEST=1 npm run test:integration`). Everything else in the suite runs without Redis.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Worker } from 'bullmq';
import { env } from '../../src/config/env';
import { prisma } from '../../src/infrastructure/database/prisma';
import { closeImportQueue, getImportQueue } from '../../src/infrastructure/queue/import-queue';
import { startImportWorker } from '../../src/modules/imports/import.worker';
import { bearer, createAccount, hdfcCsv, http, registerUser, uploadCsv, type TestUser } from '../helpers/api';
import { resetDb } from '../helpers/db';

const enabled = process.env['REDIS_TEST'] === '1';

describe.skipIf(!enabled)('background imports (Redis + BullMQ)', () => {
  let worker: Worker;
  let user: TestUser;
  let accountId: string;

  beforeAll(async () => {
    env.IMPORT_ASYNC = true;
    env.IMPORT_JOB_BACKOFF_MS = 100; // fast retries for the test
    worker = startImportWorker();
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await getImportQueue().obliterate({ force: true });
    await closeImportQueue();
    env.IMPORT_ASYNC = false;
  });

  beforeEach(async () => {
    await getImportQueue().obliterate({ force: true });
    await resetDb();
    user = await registerUser();
    accountId = (await createAccount(user)).id;
  });
  afterEach(async () => {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fault ON transactions');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fault()');
  });

  async function waitFinished(batchId: string, timeoutMs = 20_000) {
    const started = Date.now();
    for (;;) {
      const res = await http().get(`/api/v1/imports/${batchId}`).set(bearer(user));
      if (res.body.isFinished) return res.body;
      if (Date.now() - started > timeoutMs) throw new Error(`import still ${res.body.status} after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const csv = hdfcCsv([
    ['02/10/2026', 'GROCERY', 'R2', '800.00', ''],
    ['03/10/2026', 'FUEL', 'R3', '1500.00', ''],
  ]);

  it('answers 202 immediately, processes in the background, and cleans up', async () => {
    const res = await uploadCsv(user, accountId, csv);
    expect(res.status).toBe(202);
    expect(res.headers['location']).toBe(`/api/v1/imports/${res.body.batchId}`);
    expect(res.body).toMatchObject({ isFinished: false });

    const done = await waitFinished(res.body.batchId);
    expect(done).toMatchObject({ status: 'COMPLETED', acceptedRows: 2, isFinished: true });
    expect(await prisma.transaction.count()).toBe(2);
    expect(existsSync(path.resolve(env.UPLOAD_TEMP_DIR, `${res.body.batchId}.csv`))).toBe(false);

    // The same file again is a duplicate import, exactly as in synchronous mode.
    expect((await uploadCsv(user, accountId, csv)).status).toBe(409);
  });

  it('retries a transient outage with backoff and then succeeds, without duplicating rows', async () => {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fault() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated outage'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER test_fault BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION test_fault()');

    const res = await uploadCsv(user, accountId, csv);
    expect(res.status).toBe(202);
    // Let at least one attempt fail, then end the outage.
    for (let i = 0; i < 100; i++) {
      const b = await prisma.importBatch.findUniqueOrThrow({ where: { id: res.body.batchId } });
      if (b.attempts >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await prisma.$executeRawUnsafe('DROP TRIGGER test_fault ON transactions');

    const done = await waitFinished(res.body.batchId);
    expect(done.status).toBe('COMPLETED');
    expect(done.attempts).toBeGreaterThanOrEqual(2);
    expect(await prisma.transaction.count()).toBe(2);
    expect(await prisma.importRow.count({ where: { batchId: res.body.batchId } })).toBe(2);
  });

  it('ends FAILED (with the file deleted) after exhausting retries, and the file can be re-uploaded', async () => {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fault() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated outage'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER test_fault BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION test_fault()');

    const res = await uploadCsv(user, accountId, csv);
    const failed = await waitFinished(res.body.batchId);
    expect(failed).toMatchObject({ status: 'FAILED', attempts: env.IMPORT_JOB_ATTEMPTS });
    expect(await prisma.transaction.count()).toBe(0);
    expect(existsSync(path.resolve(env.UPLOAD_TEMP_DIR, `${res.body.batchId}.csv`))).toBe(false);

    await prisma.$executeRawUnsafe('DROP TRIGGER test_fault ON transactions');
    const retry = await uploadCsv(user, accountId, csv);
    expect(retry.status).toBe(202);
    expect(retry.body.batchId).toBe(res.body.batchId); // same batch revived
    const done = await waitFinished(retry.body.batchId);
    expect(done.status).toBe('COMPLETED');
    expect(await prisma.transaction.count()).toBe(2);
  });

  it('reports Redis in the readiness probe', async () => {
    const res = await http().get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ database: 'ok', redis: 'ok' });
  });
});
